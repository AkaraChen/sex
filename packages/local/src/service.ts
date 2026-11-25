import { type CallTime, createClient, type LocalClient } from "./client.ts";
import { type LocalServer, StartServerError, startServer } from "./host.ts";

export interface LocalOptions {
  /** A running firecrawl-local. Without one, a child process is started. */
  url?: string;
  /** The token of an external instance. */
  token?: string;
  /** The executable of the child process. Default: embedded, else PATH. */
  binaryPath?: string;
  /** `FIRECRAWL_CHROME_PATH`: the Chrome pages are rendered in. */
  chromePath?: string;
  /** `FIRECRAWL_LOCAL_BROWSER`. */
  browser?: "auto" | "never" | "always";
  /** Passes `--allow-private`: the child may reach loopback and private addresses. */
  allowPrivate?: boolean;
  /** Extra arguments for the child. */
  args?: readonly string[];
  env?: Record<string, string | undefined>;
  /** How long a child gets to answer `/health`. Default: 30 s. */
  timeoutMs?: number;
  onOutput?: (line: string) => void;
}

const FAILURE_LIMIT = 3;
const FAILURE_WINDOW_MS = 60_000;
const COOLDOWN_MS = 30_000;

/**
 * firecrawl-local as one dependency: a running instance at `url`, or a child process started on first use, restarted
 * after it exits, and left alone for a cooldown after repeated failed starts.
 */
export class LocalService {
  private server?: Promise<LocalServer>;
  private running?: LocalServer;
  private failures: number[] = [];
  private cooldownUntil = 0;
  private lastError = "";

  constructor(private readonly options: LocalOptions = {}) {}

  /** True when this service runs the child process itself. */
  get managed(): boolean {
    return !this.options.url;
  }

  get pid(): number | undefined {
    return this.running?.pid;
  }

  /** Base URL without a trailing slash; starts the child if needed. */
  async url(): Promise<string> {
    if (this.options.url) return this.options.url.replace(/\/$/, "");
    return (await this.getServer()).url;
  }

  /** The bearer token: the external one, or the child's per-start token. */
  async token(): Promise<string | undefined> {
    if (this.options.url) return this.options.token;
    return (await this.getServer()).token;
  }

  /** A client for this instance. Cheap: it holds no connection. */
  async client(): Promise<LocalClient> {
    return createClient({ baseUrl: await this.url(), token: await this.token() });
  }

  /** Eagerly start the child so the first scrape does not pay for it. */
  async warmup(): Promise<void> {
    if (this.managed) await this.getServer();
  }

  describe(): string {
    if (this.options.url) return this.options.url;
    return this.running ? `managed (${this.running.url}, pid ${this.running.pid})` : "managed (not started)";
  }

  async close(): Promise<void> {
    const pending = this.server;
    this.server = undefined;
    this.running = undefined;
    const server = await pending?.catch(() => undefined);
    await server?.stop();
  }

  private getServer(): Promise<LocalServer> {
    if (!this.server) {
      const attempt = this.start().catch((err) => {
        if (this.server === attempt) this.server = undefined;
        throw err;
      });
      this.server = attempt;
    }
    return this.server;
  }

  private async start(): Promise<LocalServer> {
    const now = Date.now();
    if (now < this.cooldownUntil) {
      throw new StartServerError(
        `Not starting firecrawl-local for another ${Math.ceil((this.cooldownUntil - now) / 1000)}s after ${FAILURE_LIMIT} failed starts. Last error: ${this.lastError}`,
      );
    }
    try {
      const server = await startServer({
        binaryPath: this.options.binaryPath,
        args: [...(this.options.args ?? []), ...(this.options.allowPrivate ? ["--allow-private"] : [])],
        env: {
          // Never hand user URLs to Firecrawl Cloud: this is a self-hosted instance.
          FIRECRAWL_CLOUD: "off",
          ...(this.options.chromePath ? { FIRECRAWL_CHROME_PATH: this.options.chromePath } : {}),
          ...(this.options.browser ? { FIRECRAWL_LOCAL_BROWSER: this.options.browser } : {}),
          ...this.options.env,
        },
        timeoutMs: this.options.timeoutMs,
        onOutput: this.options.onOutput,
      });
      this.failures = [];
      this.running = server;
      void server.exited.then(() => {
        if (this.running !== server) return;
        this.running = undefined;
        this.server = undefined;
      });
      return server;
    } catch (err) {
      this.recordFailure(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  private recordFailure(message: string): void {
    const now = Date.now();
    this.lastError = message;
    this.failures = [...this.failures.filter((time) => now - time < FAILURE_WINDOW_MS), now];
    if (this.failures.length < FAILURE_LIMIT) return;
    this.failures = [];
    this.cooldownUntil = now + COOLDOWN_MS;
  }
}

export type { CallTime, LocalClient };
