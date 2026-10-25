import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import defuddleBundle from "defuddle/full" with { type: "text" };
import pLimit from "p-limit";
import puppeteer, { type Page } from "puppeteer-core";
import type { Config } from "../config.ts";
import { AppError, BROWSER_HINT } from "../errors.ts";
import { log } from "../log.ts";
import type { Action } from "../schemas.ts";
import { PAGE_SCRIPT, type PageExtractOptions, type PageExtractResult } from "./page.ts";

const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

export interface BrowserScrapeOptions {
  url: string;
  timeout: number;
  headers?: Record<string, string>;
  userAgent: string;
  mobile?: boolean;
  waitFor?: number;
  actions?: Action[];
  extract: Omit<PageExtractOptions, "url">;
}

export interface BrowserScrapeResult {
  url: string;
  status: number;
  contentType: string;
  /** Set when the response is not HTML; the caller should re-fetch over plain HTTP. */
  nonHtml?: boolean;
  rawHtml: string;
  extracted?: PageExtractResult;
  actions?: {
    screenshots: string[];
    scrapes: Array<{ url: string; html: string }>;
    javascriptReturns: Array<{ type: string; value: unknown }>;
    pdfs: string[];
  };
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      srv.close(() => (typeof addr === "object" && addr ? resolve(addr.port) : reject(new Error("no port"))));
    });
  });
}

function findLightpanda(explicit?: string): string {
  const candidates = [
    explicit,
    Bun.which("lightpanda"),
    join(homedir(), ".cache", "lightpanda-node", "lightpanda"),
    join(homedir(), ".local", "bin", "lightpanda"),
  ].filter((p): p is string => !!p);
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    throw new AppError(
      501,
      "BROWSER_NOT_CONFIGURED",
      "Lightpanda binary not found. Download it from https://github.com/lightpanda-io/browser/releases and put it on PATH, or pass --lightpanda-path.",
    );
  }
  return found;
}

/** Hands out short-lived CDP connections to a Lightpanda child process or an external browser. */
export class BrowserPool {
  private proc?: Subprocess;
  private endpoint?: Promise<string>;
  private readonly limit: ReturnType<typeof pLimit>;

  constructor(private readonly config: Config) {
    this.limit = pLimit(config.concurrency);
  }

  get enabled(): boolean {
    return this.config.lightpanda || !!this.config.cdpUrl;
  }

  get kind(): string {
    return this.config.cdpUrl ? "cdp" : "lightpanda";
  }

  private async resolveEndpoint(): Promise<string> {
    if (this.config.cdpUrl) {
      const url = this.config.cdpUrl;
      if (url.startsWith("ws://") || url.startsWith("wss://")) return url;
      let body: { webSocketDebuggerUrl?: string };
      try {
        const res = await fetch(new URL("/json/version", url), { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        body = (await res.json()) as { webSocketDebuggerUrl?: string };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new AppError(502, "BROWSER_UNAVAILABLE", `Cannot reach the CDP browser at ${url}: ${reason}. ${BROWSER_HINT}`);
      }
      if (!body.webSocketDebuggerUrl) throw new Error(`No webSocketDebuggerUrl at ${url}/json/version`);
      return body.webSocketDebuggerUrl;
    }
    return this.spawnLightpanda();
  }

  private async spawnLightpanda(): Promise<string> {
    const bin = findLightpanda(this.config.lightpandaPath);
    const port = await freePort();
    const proc = Bun.spawn(
      [
        bin,
        "serve",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--log-level",
        "warn",
        "--cdp-max-connections",
        String(Math.max(16, this.config.concurrency * 2)),
        "--cdp-max-message-size",
        String(64 * 1024 * 1024),
      ],
      {
        stdout: "ignore",
        stderr: "inherit",
        env: { ...process.env, LIGHTPANDA_DISABLE_TELEMETRY: "true" },
      },
    );
    this.proc = proc;
    proc.exited.then((code) => {
      if (this.proc === proc) {
        log.warn("lightpanda exited", { code });
        this.proc = undefined;
        this.endpoint = undefined;
      }
    });
    const endpoint = `ws://127.0.0.1:${port}`;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/version`);
        if (res.ok) {
          log.info("lightpanda started", { bin, endpoint });
          return endpoint;
        }
      } catch {
        // not up yet
      }
      await Bun.sleep(100);
    }
    proc.kill();
    throw new Error("Lightpanda did not start within 15s");
  }

  private getEndpoint(): Promise<string> {
    if (!this.endpoint) {
      this.endpoint = this.resolveEndpoint().catch((err) => {
        this.endpoint = undefined;
        throw err;
      });
    }
    return this.endpoint;
  }

  /** Eagerly start the browser so the first request does not pay for it. */
  async warmup(): Promise<void> {
    if (this.enabled) await this.getEndpoint();
  }

  async withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
    return this.limit(async () => {
      const browser = await puppeteer.connect({ browserWSEndpoint: await this.getEndpoint(), defaultViewport: null });
      try {
        const context = await browser.createBrowserContext();
        try {
          const page = await context.newPage();
          return await fn(page);
        } finally {
          await context.close().catch(() => {});
        }
      } finally {
        await browser.disconnect().catch(() => {});
      }
    });
  }

  async scrape(opts: BrowserScrapeOptions): Promise<BrowserScrapeResult> {
    return this.withPage(async (page) => {
      page.setDefaultTimeout(opts.timeout);
      page.setDefaultNavigationTimeout(opts.timeout);
      await page.setUserAgent(opts.mobile ? MOBILE_UA : opts.userAgent).catch(() => {});
      if (opts.headers && Object.keys(opts.headers).length) {
        await page.setExtraHTTPHeaders(opts.headers).catch(() => {});
      }
      const viewport = opts.mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 };
      await page.setViewport({ ...viewport, isMobile: !!opts.mobile }).catch(() => {});

      const response = await page.goto(opts.url, { waitUntil: "load", timeout: opts.timeout }).catch((err: Error) => {
        if (err.name === "TimeoutError") {
          throw new AppError(408, "SCRAPE_TIMEOUT", `Timed out after ${opts.timeout}ms loading ${opts.url}`);
        }
        throw new AppError(502, "FETCH_FAILED", `Browser failed to load ${opts.url}: ${err.message}`);
      });
      const contentType = response?.headers()["content-type"] ?? "text/html";
      const base = { url: page.url() || opts.url, status: response?.status() ?? 200, contentType };
      if (!/html|xml/i.test(contentType)) return { ...base, nonHtml: true, rawHtml: "" };

      if (opts.waitFor) await Bun.sleep(opts.waitFor);
      const actions = opts.actions?.length ? await runActions(page, opts.actions) : undefined;

      const rawHtml = await page.content();
      const extracted = await runPageScript(page, { ...opts.extract, url: page.url() || opts.url });
      return { ...base, url: page.url() || opts.url, rawHtml, extracted, actions };
    });
  }

  async close(): Promise<void> {
    const proc = this.proc;
    this.proc = undefined;
    this.endpoint = undefined;
    if (proc) {
      proc.kill();
      await proc.exited.catch(() => {});
    }
  }
}

async function runPageScript(page: Page, opts: PageExtractOptions): Promise<PageExtractResult> {
  const hasDefuddle = await page.evaluate("typeof window.Defuddle === 'function'");
  if (!hasDefuddle) await page.evaluate(defuddleBundle as unknown as string);
  return (await page.evaluate(
    `(${PAGE_SCRIPT})(document, ${JSON.stringify(opts)}, (d, o) => new window.Defuddle(d, o).parseAsync())`,
  )) as PageExtractResult;
}

async function runActions(page: Page, actions: Action[]): Promise<NonNullable<BrowserScrapeResult["actions"]>> {
  const out: NonNullable<BrowserScrapeResult["actions"]> = { screenshots: [], scrapes: [], javascriptReturns: [], pdfs: [] };
  for (const [i, action] of actions.entries()) {
    try {
      switch (action.type) {
        case "wait":
          if (action.selector) await page.waitForSelector(action.selector);
          else await Bun.sleep(action.milliseconds ?? 1000);
          break;
        case "click":
          if (action.all) {
            for (const el of await page.$$(action.selector)) await el.click();
          } else await page.click(action.selector);
          break;
        case "write":
          await page.keyboard.type(action.text);
          break;
        case "press":
          await page.keyboard.press(action.key as Parameters<Page["keyboard"]["press"]>[0]);
          break;
        case "scroll": {
          // Page-side code is passed as a string: the bundler may rename globals inside functions.
          const sign = action.direction === "up" ? -1 : 1;
          await page.evaluate(
            `(() => {
              const el = ${JSON.stringify(action.selector ?? null)} ? document.querySelector(${JSON.stringify(action.selector ?? "")}) : null;
              if (el) el.scrollBy(0, ${sign} * el.clientHeight);
              else window.scrollBy(0, ${sign} * window.innerHeight);
            })()`,
          );
          break;
        }
        case "scrape":
          out.scrapes.push({ url: page.url(), html: await page.content() });
          break;
        case "executeJavascript": {
          let value: unknown;
          try {
            value = await page.evaluate(action.script);
          } catch (err) {
            // Scripts written as function bodies (`return ...`) are not valid expressions.
            if (!(err instanceof Error) || !/return|SyntaxError/i.test(err.message)) throw err;
            value = await page.evaluate(`(async () => { ${action.script}\n })()`);
          }
          out.javascriptReturns.push({ type: value === null ? "null" : typeof value, value });
          break;
        }
      }
    } catch (err) {
      throw new AppError(400, "ACTION_FAILED", `Action #${i} (${action.type}) failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}
