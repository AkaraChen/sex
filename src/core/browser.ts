import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
import { applyRequestPolicies } from "./browser-policy.ts";
import { MARKUP_TYPE } from "./net.ts";
import { PAGE_SCRIPT, type PageExtractOptions, type PageExtractResult } from "./page.ts";

const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

/** How long a freshly spawned Lightpanda gets to answer on its CDP port. */
const STARTUP_TIMEOUT_MS = 15_000;
/** This many failed starts within START_FAILURE_WINDOW_MS stop further spawn attempts for START_COOLDOWN_MS. */
const START_FAILURE_LIMIT = 3;
const START_FAILURE_WINDOW_MS = 60_000;
const START_COOLDOWN_MS = 30_000;

export interface BrowserScrapeOptions {
  url: string;
  timeout: number;
  /**
   * Sent with the page's requests. `Authorization` / `Proxy-Authorization` reach the target's origin only, `Cookie` is stored as
   * host-only cookies of the target's host; everything else goes to every request (see browser-policy.ts).
   */
  headers?: Record<string, string>;
  userAgent: string;
  mobile?: boolean;
  waitFor?: number;
  actions?: Action[];
  extract: Omit<PageExtractOptions, "url">;
  /** Checked for every request the browser makes (documents, redirects, subresources). Resolves true when allowed. */
  requestGuard?: (url: string) => Promise<boolean>;
  /** Accept invalid TLS certificates (Chrome only; CDP Security.setIgnoreCertificateErrors). */
  skipTlsVerification?: boolean;
  /** Aborting closes the page's browser context, freeing its slot immediately. */
  signal?: AbortSignal;
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

/** Lightpanda embedded in the compiled binary by `scripts/build.ts`, zstd-compressed. */
let embedded: { version: string; sha256: string; file: string } | undefined;

export function registerEmbeddedLightpanda(version: string, sha256: string, file: string): void {
  embedded = { version, sha256, file };
}

/** Decompresses the embedded Lightpanda to $XDG_CACHE_HOME/sex/lightpanda-<version>-<hash>/ (once) and returns its path. */
async function extractEmbeddedLightpanda(bundle: { version: string; sha256: string; file: string }): Promise<string> {
  const dir = join(
    process.env.XDG_CACHE_HOME || join(homedir(), ".cache"),
    "sex",
    `lightpanda-${bundle.version}-${bundle.sha256.slice(0, 16)}`,
  );
  const bin = join(dir, "lightpanda");
  if (existsSync(bin)) return bin;
  const t0 = performance.now();
  mkdirSync(dir, { recursive: true });
  // Write beside the target and rename, so an interrupted extraction is never mistaken for a complete one.
  const tmp = `${bin}.tmp-${process.pid}`;
  writeFileSync(tmp, Bun.zstdDecompressSync(await Bun.file(bundle.file).bytes()));
  chmodSync(tmp, 0o755);
  try {
    renameSync(tmp, bin);
  } catch (err) {
    // Another sex process finished the same extraction first.
    rmSync(tmp, { force: true });
    if (!existsSync(bin)) throw err;
  }
  log.info("lightpanda extracted", { bin, version: bundle.version, ms: Math.round(performance.now() - t0) });
  return bin;
}

/** An explicit path, else the Lightpanda embedded in this binary, else one on PATH or in the usual install locations. */
async function findLightpanda(explicit?: string): Promise<string> {
  if (!explicit && embedded) return extractEmbeddedLightpanda(embedded);
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
      "Lightpanda binary not found (this sex was not built with one embedded). Download it from https://github.com/lightpanda-io/browser/releases and put it on PATH, or pass --lightpanda-path.",
    );
  }
  return found;
}

/**
 * Command prefix that makes the kernel send the child SIGTERM when sex dies, even on SIGKILL (`setpriv` from util-linux >= 2.33
 * sets PR_SET_PDEATHSIG and then execs, so the child keeps the spawned PID). Linux only: macOS has no such mechanism, and a
 * Linux host without `setpriv` falls back to a plain spawn, which leaves the child orphaned if sex is SIGKILLed.
 * The kernel ties the signal to the thread that spawned the child, so spawn from the main thread, not from a worker.
 */
export function pdeathsigWrapper(): string[] | undefined {
  if (process.platform !== "linux") return undefined;
  const setpriv = Bun.which("setpriv");
  return setpriv ? [setpriv, "--pdeathsig", "TERM", "--"] : undefined;
}

/** The `lightpanda serve` command line for this config, optionally behind a wrapper such as `pdeathsigWrapper()`. */
export function lightpandaArgv(
  bin: string,
  port: number,
  config: Pick<Config, "concurrency" | "allowPrivateNetwork">,
  wrapper: string[] = [],
): string[] {
  return [
    ...wrapper,
    bin,
    "serve",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--log-level",
    "warn",
    "--cdp-max-connections",
    String(Math.max(16, config.concurrency * 2)),
    "--cdp-max-message-size",
    String(64 * 1024 * 1024),
    // Second line of defence: Lightpanda refuses private addresses after DNS resolution. The request interception in
    // scrapeInner stays the primary guard, because an external --cdp-url browser has no such flag.
    ...(config.allowPrivateNetwork ? [] : ["--block-private-networks"]),
  ];
}

const startFailed = (reason: string) => new AppError(502, "BROWSER_UNAVAILABLE", `Lightpanda did not start: ${reason}`);

/** Hands out short-lived CDP connections to a Lightpanda child process or an external browser. */
export class BrowserPool {
  private proc?: Subprocess;
  private endpoint?: Promise<string>;
  private readonly limit: ReturnType<typeof pLimit>;
  /** Timestamps of recent failed Lightpanda starts, and the end of the resulting spawn pause. */
  private startFailures: number[] = [];
  private cooldownUntil = 0;
  private lastStartError = "";

  constructor(private readonly config: Config) {
    this.limit = pLimit(config.concurrency);
  }

  /** PID of the Lightpanda child process, while there is one. */
  get pid(): number | undefined {
    return this.proc?.pid;
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

  /**
   * Spawns the child on demand; it is spawned again after it exits. A binary that keeps failing to start is not retried in a
   * tight loop: after START_FAILURE_LIMIT failed starts within START_FAILURE_WINDOW_MS, spawning pauses for START_COOLDOWN_MS.
   */
  private async spawnLightpanda(): Promise<string> {
    const now = Date.now();
    if (now < this.cooldownUntil) {
      throw new AppError(
        502,
        "BROWSER_UNAVAILABLE",
        `Not starting Lightpanda for another ${Math.ceil((this.cooldownUntil - now) / 1000)}s after ${START_FAILURE_LIMIT} failed starts. Last error: ${this.lastStartError}`,
      );
    }
    const bin = await findLightpanda(this.config.lightpandaPath);
    try {
      const endpoint = await this.startLightpanda(bin);
      this.startFailures = [];
      return endpoint;
    } catch (err) {
      const failure = err instanceof AppError ? err : startFailed(err instanceof Error ? err.message : String(err));
      this.recordStartFailure(failure.message);
      throw failure;
    }
  }

  private recordStartFailure(message: string): void {
    const now = Date.now();
    this.lastStartError = message;
    this.startFailures = [...this.startFailures.filter((t) => now - t < START_FAILURE_WINDOW_MS), now];
    if (this.startFailures.length < START_FAILURE_LIMIT) return;
    this.startFailures = [];
    this.cooldownUntil = now + START_COOLDOWN_MS;
    log.error("lightpanda keeps failing to start; pausing restarts", {
      failures: START_FAILURE_LIMIT,
      pauseMs: START_COOLDOWN_MS,
      error: message,
    });
  }

  private async startLightpanda(bin: string): Promise<string> {
    const port = await freePort();
    const wrapper = pdeathsigWrapper();
    const argv = lightpandaArgv(bin, port, this.config, wrapper);
    log.debug("spawning lightpanda", { argv });
    let proc: Subprocess;
    try {
      proc = Bun.spawn(argv, {
        stdout: "ignore",
        stderr: "inherit",
        env: { ...process.env, LIGHTPANDA_DISABLE_TELEMETRY: "true" },
      });
    } catch (err) {
      throw startFailed(`cannot execute ${bin}: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.proc = proc;
    proc.exited.then((code) => {
      if (this.proc === proc) {
        log.warn("lightpanda exited", { code, signal: proc.signalCode });
        this.proc = undefined;
        this.endpoint = undefined;
      }
    });
    const endpoint = `ws://127.0.0.1:${port}`;
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null || proc.signalCode !== null) {
        throw startFailed(`exited with ${proc.signalCode ? `signal ${proc.signalCode}` : `code ${proc.exitCode}`}`);
      }
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2_000) });
        if (res.ok) {
          log.info("lightpanda started", { bin, endpoint, spawn: wrapper ? "setpriv" : "direct" });
          return endpoint;
        }
      } catch {
        // not up yet
      }
      await Bun.sleep(100);
    }
    proc.kill("SIGKILL");
    throw startFailed(`no answer on ${endpoint} within ${STARTUP_TIMEOUT_MS / 1000}s`);
  }

  private getEndpoint(): Promise<string> {
    if (!this.endpoint) {
      const attempt: Promise<string> = this.resolveEndpoint().catch((err) => {
        // The exit handler may already have started a newer attempt; only clear our own.
        if (this.endpoint === attempt) this.endpoint = undefined;
        throw err;
      });
      this.endpoint = attempt;
    }
    return this.endpoint;
  }

  /** Eagerly start the browser so the first request does not pay for it. */
  async warmup(): Promise<void> {
    if (this.enabled) await this.getEndpoint();
  }

  async withPage<T>(fn: (page: Page) => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.limit(async () => {
      if (signal?.aborted) throw new AppError(408, "TIMEOUT", "Browser scrape cancelled before it started");
      const browser = await puppeteer.connect({ browserWSEndpoint: await this.getEndpoint(), defaultViewport: null });
      try {
        const context = await browser.createBrowserContext();
        // Closing the context makes in-flight page operations reject, so the slot is released at once.
        let closed = false;
        const close = () => {
          if (closed) return;
          closed = true;
          context.close().catch(() => {});
        };
        const onAbort = () => close();
        signal?.addEventListener("abort", onAbort, { once: true });
        try {
          if (signal?.aborted) throw new AppError(408, "TIMEOUT", "Browser scrape cancelled before it started");
          const page = await context.newPage();
          return await fn(page);
        } finally {
          signal?.removeEventListener("abort", onAbort);
          close();
        }
      } finally {
        await browser.disconnect().catch(() => {});
      }
    });
  }

  async scrape(opts: BrowserScrapeOptions): Promise<BrowserScrapeResult> {
    return this.scrapeInner(opts).catch((err: unknown) => {
      if (opts.signal?.aborted) throw new AppError(408, "TIMEOUT", "Browser scrape cancelled");
      throw err;
    });
  }

  private async scrapeInner(opts: BrowserScrapeOptions): Promise<BrowserScrapeResult> {
    return this.withPage(async (page) => {
      page.setDefaultTimeout(opts.timeout);
      page.setDefaultNavigationTimeout(opts.timeout);
      await page.setUserAgent(opts.mobile ? MOBILE_UA : opts.userAgent).catch(() => {});
      const viewport = opts.mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 };
      await page.setViewport({ ...viewport, isMobile: !!opts.mobile }).catch(() => {});

      // Headers, cookies and request interception; see browser-policy.ts.
      const { blockedNavigations: blockedDocs } = await applyRequestPolicies(page, {
        url: opts.url,
        headers: opts.headers,
        requestGuard: opts.requestGuard,
      });

      if (opts.skipTlsVerification) {
        // Best effort: browsers without the Security domain (Lightpanda) keep their own certificate handling.
        await page
          .createCDPSession()
          .then((cdp) => cdp.send("Security.setIgnoreCertificateErrors", { ignore: true }))
          .catch(() => {});
      }

      let aborted = false;
      const response = await page.goto(opts.url, { waitUntil: "load", timeout: opts.timeout }).catch((err: Error) => {
        if (blockedDocs.length) return null;
        // PDFs and Content-Disposition: attachment responses abort the navigation; the caller re-fetches them over HTTP.
        if (err.message.includes("net::ERR_ABORTED")) {
          aborted = true;
          return null;
        }
        if (err.name === "TimeoutError") {
          throw new AppError(408, "SCRAPE_TIMEOUT", `Timed out after ${opts.timeout}ms loading ${opts.url}`);
        }
        throw new AppError(502, "FETCH_FAILED", `Browser failed to load ${opts.url}: ${err.message}`);
      });
      if (blockedDocs.length) {
        throw new AppError(403, "PRIVATE_NETWORK_BLOCKED", `Refusing to fetch private address: ${blockedDocs[0]}`);
      }
      if (aborted) return { url: opts.url, status: 200, contentType: "", nonHtml: true, rawHtml: "" };
      const contentType = response?.headers()["content-type"] ?? "text/html";
      const base = { url: page.url() || opts.url, status: response?.status() ?? 200, contentType };
      if (!MARKUP_TYPE.test(contentType)) return { ...base, nonHtml: true, rawHtml: "" };

      if (opts.waitFor) await Bun.sleep(opts.waitFor);
      const actions = opts.actions?.length ? await runActions(page, opts.actions) : undefined;

      const rawHtml = await page.content();
      const extracted = await runPageScript(page, { ...opts.extract, url: page.url() || opts.url });
      return { ...base, url: page.url() || opts.url, rawHtml, extracted, actions };
    }, opts.signal);
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
