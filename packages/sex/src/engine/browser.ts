import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BrowserScrapeOptions, BrowserScrapeResult, ScrapeBrowser } from "@sex/core/capabilities.ts";
import type { Deadline } from "@sex/core/deadline.ts";
import { AppError, BROWSER_HINT } from "@sex/core/errors.ts";
import { log } from "@sex/core/log.ts";
import { MARKUP_TYPE, networkError } from "@sex/core/net.ts";
import { PAGE_SCRIPT, type PageExtractOptions, type PageExtractResult } from "@sex/core/page.ts";
import type { Subprocess } from "bun";
import defuddleBundle from "defuddle/full" with { type: "text" };
import pLimit from "p-limit";
import puppeteer, { type Page } from "puppeteer-core";
import type { Config } from "../config.ts";
import type { Action } from "../schemas.ts";
import { type AdBlockList, loadAdBlockList } from "./adblock.ts";
import { applyRequestPolicies } from "./browser-policy.ts";
import { CdpGuard, cdpGuardSkipReason, GUARD_BYPASS_LIST, type GuardResolver, type GuardSession } from "./cdp-guard.ts";

const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

/** How long a freshly spawned Lightpanda gets to answer on its CDP port. */
const STARTUP_TIMEOUT_MS = 15_000;
/** This many failed starts within START_FAILURE_WINDOW_MS stop further spawn attempts for START_COOLDOWN_MS. */
const START_FAILURE_LIMIT = 3;
const START_FAILURE_WINDOW_MS = 60_000;
const START_COOLDOWN_MS = 30_000;

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
  config: Pick<Config, "concurrency" | "allowPrivateNetwork" | "proxyUrl">,
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
    // Lightpanda's own flag, so every page request goes through the proxy. Credentials in the URL end up on its command line.
    ...(config.proxyUrl ? ["--http-proxy", config.proxyUrl] : []),
  ];
}

/** `argv` for a log line, without the credentials of the `--http-proxy` URL. */
export function redactArgv(argv: string[]): string[] {
  return argv.map((arg, i) => (argv[i - 1] === "--http-proxy" ? redactUrl(arg) : arg));
}

function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.username || url.password) {
      url.username = "***";
      url.password = "";
    }
    return url.href;
  } catch {
    return "<invalid>";
  }
}

/**
 * How an external CDP browser reaches the proxy: Chrome takes the proxy per browser context (`proxyServer`, no credentials in
 * it) and gets the credentials by answering the proxy's auth challenge. A spawned Lightpanda has its proxy on the command line.
 */
export function contextProxy(
  config: Pick<Config, "cdpUrl" | "proxyUrl">,
): { server: string; credentials?: { username: string; password: string } } | undefined {
  if (!config.cdpUrl || !config.proxyUrl) return undefined;
  const url = new URL(config.proxyUrl);
  const credentials = url.username ? { username: decodeURIComponent(url.username), password: decodeURIComponent(url.password) } : undefined;
  return { server: `${url.protocol}//${url.host}`, ...(credentials ? { credentials } : {}) };
}

const startFailed = (reason: string) => new AppError("BROWSER_UNAVAILABLE", `Lightpanda did not start: ${reason}`);

/** Hands out short-lived CDP connections to a Lightpanda child process or an external browser. */
export class BrowserPool implements ScrapeBrowser {
  private proc?: Subprocess;
  private endpoint?: Promise<string>;
  private readonly limit: ReturnType<typeof pLimit>;
  /** Timestamps of recent failed Lightpanda starts, and the end of the resulting spawn pause. */
  private startFailures: number[] = [];
  private cooldownUntil = 0;
  private lastStartError = "";
  /** The CDP guard proxy, started on first use; see cdp-guard.ts. */
  private guard?: Promise<CdpGuard | undefined>;

  /** `adBlockList` is where the ad list comes from and `guardResolve` how the CDP guard proxy resolves names; tests and the benchmark swap them. */
  constructor(
    private readonly config: Config,
    private readonly adBlockList: () => Promise<AdBlockList> = loadAdBlockList,
    private readonly guardResolve?: GuardResolver,
  ) {
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
        throw new AppError("BROWSER_UNAVAILABLE", `Cannot reach the CDP browser at ${url}: ${reason}. ${BROWSER_HINT}`);
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
    log.debug("spawning lightpanda", { argv: redactArgv(argv) });
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

  /** The guard proxy for an external CDP browser, started once; `undefined` (with the reason logged once) when it does not apply. */
  private getGuard(): Promise<CdpGuard | undefined> {
    this.guard ??= (async () => {
      const reason = cdpGuardSkipReason(this.config);
      if (reason) {
        if (this.config.cdpUrl) log.info("cdp guard proxy not used", { reason });
        return undefined;
      }
      return CdpGuard.start(this.guardResolve);
    })().catch((err) => {
      this.guard = undefined;
      throw new AppError(
        "BROWSER_UNAVAILABLE",
        `Could not start the SSRF guard proxy for the CDP browser: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    return this.guard;
  }

  /** Eagerly start the browser so the first request does not pay for it. */
  async warmup(): Promise<void> {
    if (!this.enabled) return;
    await Promise.all([this.getEndpoint(), this.getGuard(), this.adBlockList()]);
  }

  /**
   * Runs `fn` on a fresh page in its own browser context, once a slot is free. The context is closed when `fn` ends or the
   * deadline does, which makes in-flight page operations reject, so the slot is released at once; `fn` is also abandoned at
   * the deadline if what it is awaiting ignores the closed context. The error is the deadline's, never a symptom of the close.
   */
  async withPage<T>(fn: (page: Page, guardBlocked: string[]) => Promise<T>, deadline: Deadline): Promise<T> {
    return this.limit(async () => {
      deadline.throwIfAborted("before the browser scrape started");
      const endpoint = await deadline.bound(this.getEndpoint(), "while starting the browser");
      const guard = await deadline.bound(this.getGuard(), "while starting the SSRF guard proxy");
      const connecting = puppeteer.connect({ browserWSEndpoint: endpoint, defaultViewport: null });
      let browser: Awaited<typeof connecting>;
      try {
        browser = await deadline.bound(connecting, "while connecting to the browser");
      } catch (err) {
        connecting.then((b) => b.disconnect()).catch(() => {});
        throw err;
      }
      // The guard and an upstream proxy exclude each other (cdpGuardSkipReason), so at most one of them is set.
      const session: GuardSession | undefined = guard?.session();
      try {
        const proxy = session ?? contextProxy(this.config);
        const context = await browser.createBrowserContext(
          proxy ? { proxyServer: proxy.server, ...(session ? { proxyBypassList: GUARD_BYPASS_LIST } : {}) } : undefined,
        );
        let closed = false;
        const close = () => {
          if (closed) return;
          closed = true;
          context.close().catch(() => {});
        };
        deadline.signal.addEventListener("abort", close, { once: true });
        try {
          deadline.throwIfAborted("before the browser scrape started");
          const page = await context.newPage();
          if (proxy?.credentials) await deadline.bound(page.authenticate(proxy.credentials));
          return await deadline.bound(fn(page, session?.blocked ?? []));
        } finally {
          deadline.signal.removeEventListener("abort", close);
          close();
        }
      } finally {
        session?.release();
        await browser.disconnect().catch(() => {});
      }
    });
  }

  async scrape(opts: BrowserScrapeOptions): Promise<BrowserScrapeResult> {
    const { deadline } = opts;
    return this.scrapeInner(opts).catch((err: unknown) => {
      throw deadline.translate(err, `while rendering ${opts.url}`);
    });
  }

  private async scrapeInner(opts: BrowserScrapeOptions): Promise<BrowserScrapeResult> {
    const { deadline } = opts;
    return this.withPage(async (page, guardBlocked) => {
      page.setDefaultTimeout(stepTimeout(deadline));
      page.setDefaultNavigationTimeout(stepTimeout(deadline));
      await page.setUserAgent(opts.mobile ? MOBILE_UA : opts.userAgent).catch(() => {});
      const viewport = opts.mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 };
      await page.setViewport({ ...viewport, isMobile: !!opts.mobile }).catch(() => {});

      // Headers, cookies and request interception; see browser-policy.ts.
      const { blockedNavigations: blockedDocs, adsBlocked } = await applyRequestPolicies(page, {
        url: opts.url,
        headers: opts.headers,
        requestGuard: opts.requestGuard,
        adBlockList: opts.blockAds ? await this.adBlockList() : undefined,
        blockMedia: this.config.blockMedia,
      });

      if (opts.skipTlsVerification) {
        // Best effort: browsers without the Security domain (Lightpanda) keep their own certificate handling.
        await page
          .createCDPSession()
          .then((cdp) => cdp.send("Security.setIgnoreCertificateErrors", { ignore: true }))
          .catch(() => {});
      }

      let aborted = false;
      const response = await page.goto(opts.url, { waitUntil: "load", timeout: stepTimeout(deadline) }).catch((err: Error) => {
        deadline.throwIfAborted(`while loading ${opts.url}`);
        if (blockedDocs.length || guardRefused(guardBlocked, opts.url)) return null;
        // PDFs and Content-Disposition: attachment responses abort the navigation; the caller re-fetches them over HTTP.
        if (err.message.includes("net::ERR_ABORTED")) {
          aborted = true;
          return null;
        }
        if (err.name === "TimeoutError") throw deadline.timedOut(`while loading ${opts.url}`);
        throw networkError(err, opts.url, { skipTlsVerification: opts.skipTlsVerification });
      });
      // The guard answers a refused plain-HTTP navigation with a 403 page of its own; a refused CONNECT fails the navigation.
      if (blockedDocs.length || guardRefused(guardBlocked, opts.url) || response?.headers()["x-sex-guard"] === "blocked") {
        throw new AppError("PRIVATE_NETWORK_BLOCKED", `Refusing to fetch private address: ${blockedDocs[0] ?? opts.url}`);
      }
      if (aborted) return { url: opts.url, status: 200, contentType: "", nonHtml: true, rawHtml: "" };
      const contentType = response?.headers()["content-type"] ?? "text/html";
      const base = { url: page.url() || opts.url, status: response?.status() ?? 200, contentType, adsBlocked: adsBlocked() };
      if (!MARKUP_TYPE.test(contentType)) return { ...base, nonHtml: true, rawHtml: "" };

      if (opts.waitFor) await deadline.sleep(opts.waitFor, "while waiting (waitFor)");
      const actions = opts.actions?.length ? await runActions(page, opts.actions, deadline) : undefined;

      const rawHtml = await page.content();
      const extracted = await runPageScript(page, { ...opts.extract, url: page.url() || opts.url });
      return { ...base, url: page.url() || opts.url, rawHtml, extracted, actions };
    }, deadline);
  }

  async close(): Promise<void> {
    const guard = this.guard;
    this.guard = undefined;
    await guard?.then((g) => g?.close()).catch(() => {});
    const proc = this.proc;
    this.proc = undefined;
    this.endpoint = undefined;
    if (proc) {
      proc.kill();
      await proc.exited.catch(() => {});
    }
  }
}

/** True when the CDP guard proxy refused the host of this navigation. */
function guardRefused(blocked: string[], url: string): boolean {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return blocked.includes(host);
}

/** Puppeteer wants a timeout in ms, where 0 means never: what is left, at least 1 and within a timer's range. */
function stepTimeout(deadline: Deadline): number {
  return Math.max(1, Math.min(deadline.remaining(), 2 ** 31 - 1));
}

async function runPageScript(page: Page, opts: PageExtractOptions): Promise<PageExtractResult> {
  const hasDefuddle = await page.evaluate("typeof window.Defuddle === 'function'");
  if (!hasDefuddle) await page.evaluate(defuddleBundle as unknown as string);
  return (await page.evaluate(
    `(${PAGE_SCRIPT})(document, ${JSON.stringify(opts)}, (d, o) => new window.Defuddle(d, o).parseAsync())`,
  )) as PageExtractResult;
}

async function runActions(page: Page, actions: Action[], deadline: Deadline): Promise<NonNullable<BrowserScrapeResult["actions"]>> {
  const out: NonNullable<BrowserScrapeResult["actions"]> = { screenshots: [], scrapes: [], javascriptReturns: [], pdfs: [] };
  for (const [i, action] of actions.entries()) {
    try {
      switch (action.type) {
        case "wait":
          if (action.selector !== undefined) await page.waitForSelector(action.selector, { timeout: stepTimeout(deadline) });
          else await deadline.sleep(action.milliseconds ?? 0, `while waiting in action #${i}`);
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
      deadline.throwIfAborted(`while running action #${i} (${action.type})`);
      if (err instanceof Error && err.name === "TimeoutError") throw deadline.timedOut(`while running action #${i} (${action.type})`);
      throw new AppError("ACTION_FAILED", `Action #${i} (${action.type}) failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}
