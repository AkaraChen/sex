import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type SearxngServer, StartServerError, startServer } from "@searxng-js/searxng";
import type { CoreConfig as Config } from "./config.ts";
import { AppError } from "./errors.ts";
import { log } from "./log.ts";
import { generatedSettings, proxyHost, redactProxy } from "./searxng-settings.ts";

/** How long a managed SearXNG gets to answer /healthz; the first start unpacks the binary. */
const STARTUP_TIMEOUT_MS = 60_000;
/** This many failed starts within START_FAILURE_WINDOW_MS stop further start attempts for START_COOLDOWN_MS. */
const START_FAILURE_LIMIT = 3;
const START_FAILURE_WINDOW_MS = 60_000;
const START_COOLDOWN_MS = 30_000;

const unavailable = (message: string) => new AppError("SEARCH_BACKEND_UNAVAILABLE", message);

/** The last few non-empty lines of server output, for error messages. */
const tail = (output: string, lines = 5) =>
  output
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-lines)
    .join(" | ");

/**
 * The SearXNG instance searches go to: the external one at SEX_SEARXNG_URL, or else a SearXNG child process
 * (the prebuilt binary from @searxng-js/searxng, embedded in `dist/sex`). The child is started on first use (or by
 * `serve` warmup), started again after it exits, and not restarted for a cooldown after repeated failed starts.
 * It exits with sex even on SIGKILL: it watches its stdin pipe.
 */
export class SearxngService {
  private server?: Promise<SearxngServer>;
  private running?: SearxngServer;
  private startFailures: number[] = [];
  private cooldownUntil = 0;
  private lastStartError = "";

  constructor(private readonly config: Config) {}

  /** True when sex runs SearXNG itself (no SEX_SEARXNG_URL). */
  get managed(): boolean {
    return !this.config.searxngUrl;
  }

  /** PID of the managed SearXNG process, while there is one. */
  get pid(): number | undefined {
    return this.running?.pid;
  }

  /** Base URL without a trailing slash; starts the managed instance if needed. */
  async url(): Promise<string> {
    if (this.config.searxngUrl) return this.config.searxngUrl;
    return (await this.getServer()).url;
  }

  /** Eagerly start the managed instance so the first search does not pay for it. */
  async warmup(): Promise<void> {
    if (this.managed) await this.getServer();
  }

  describe(): string {
    if (this.config.searxngUrl) return this.config.searxngUrl;
    return this.running ? `managed (${this.running.url}, pid ${this.running.pid})` : "managed (not started)";
  }

  private getServer(): Promise<SearxngServer> {
    if (!this.server) {
      const attempt: Promise<SearxngServer> = this.start().catch((err) => {
        if (this.server === attempt) this.server = undefined;
        throw err;
      });
      this.server = attempt;
    }
    return this.server;
  }

  private async start(): Promise<SearxngServer> {
    const now = Date.now();
    if (now < this.cooldownUntil) {
      throw unavailable(
        `Not starting SearXNG for another ${Math.ceil((this.cooldownUntil - now) / 1000)}s after ${START_FAILURE_LIMIT} failed starts. Last error: ${this.lastStartError}`,
      );
    }
    const started = performance.now();
    const { proxyUrl } = this.config;
    const generated = generatedSettings(this.config);
    if (proxyUrl && !generated && this.managed) {
      log.info("SEX_PROXY_URL is not applied to SearXNG: SEX_SEARXNG_SETTINGS is the operator's file; set outgoing.proxies in it");
    }
    let server: SearxngServer;
    let settingsDir: string | undefined;
    try {
      let settingsPath = this.config.searxngSettings;
      if (generated !== undefined) {
        // The file holds the proxy's credentials: private directory and mode, and gone as soon as SearXNG has read it.
        settingsDir = await mkdtemp(join(tmpdir(), "sex-searxng-"));
        settingsPath = join(settingsDir, "settings.yml");
        await writeFile(settingsPath, generated, { mode: 0o600 });
        log.info("searxng outgoing requests go through the proxy", { proxy: proxyHost(this.config.proxyUrl as string) });
      }
      server = await startServer({
        binaryPath: this.config.searxngPath,
        settingsPath,
        timeoutMs: STARTUP_TIMEOUT_MS,
        onOutput: (chunk) => log.debug("searxng", { output: redactProxy(chunk.trimEnd(), proxyUrl) }),
      });
    } catch (err) {
      const output = err instanceof StartServerError ? redactProxy(tail(err.output), proxyUrl) : "";
      const reason = redactProxy((err instanceof Error ? err.message : String(err)).split("\n--- server output ---")[0] ?? "", proxyUrl);
      const failure = unavailable(
        `SearXNG did not start: ${reason}${output ? ` (output: ${output})` : ""}. Set SEX_SEARXNG_URL to use a running SearXNG instead.`,
      );
      this.recordStartFailure(failure.message);
      throw failure;
    } finally {
      if (settingsDir) await rm(settingsDir, { recursive: true, force: true });
    }
    this.startFailures = [];
    this.running = server;
    log.info("searxng started", { url: server.url, pid: server.pid, ms: Math.round(performance.now() - started) });
    void server.exited.then((code) => {
      if (this.running !== server) return;
      log.warn("searxng exited", { code });
      this.running = undefined;
      this.server = undefined;
    });
    return server;
  }

  private recordStartFailure(message: string): void {
    const now = Date.now();
    this.lastStartError = message;
    this.startFailures = [...this.startFailures.filter((t) => now - t < START_FAILURE_WINDOW_MS), now];
    if (this.startFailures.length < START_FAILURE_LIMIT) return;
    this.startFailures = [];
    this.cooldownUntil = now + START_COOLDOWN_MS;
    log.error("searxng keeps failing to start; pausing restarts", {
      failures: START_FAILURE_LIMIT,
      pauseMs: START_COOLDOWN_MS,
      error: message,
    });
  }

  async close(): Promise<void> {
    const pending = this.server;
    this.server = undefined;
    this.running = undefined;
    const server = await pending?.catch(() => undefined);
    await server?.stop();
  }
}
