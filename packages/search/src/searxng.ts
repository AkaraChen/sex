import { createClient, type SearxngClient, type SearxngServer, startServer } from "@searxng-js/searxng";

export interface SearxngOptions {
  /** A running SearXNG. Without one, a child process is started from the prebuilt binary. */
  url?: string;
  binaryPath?: string;
  /** How long a child gets to answer `/healthz`. Default: 60 s (the first start unpacks the binary). */
  timeoutMs?: number;
  onOutput?: (line: string) => void;
}

const FAILURE_LIMIT = 3;
const FAILURE_WINDOW_MS = 60_000;
const COOLDOWN_MS = 30_000;

/** SearXNG as one dependency: an external instance, or the child process `@searxng-js/searxng` starts. */
export class Searxng {
  private server?: Promise<SearxngServer>;
  private running?: SearxngServer;
  private failures: number[] = [];
  private cooldownUntil = 0;
  private lastError = "";

  constructor(private readonly options: SearxngOptions = {}) {}

  get managed(): boolean {
    return !this.options.url;
  }

  get pid(): number | undefined {
    return this.running?.pid;
  }

  async client(): Promise<SearxngClient> {
    return createClient({ baseUrl: await this.url() });
  }

  async url(): Promise<string> {
    if (this.options.url) return this.options.url.replace(/\/$/, "");
    return (await this.getServer()).url;
  }

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

  private getServer(): Promise<SearxngServer> {
    if (!this.server) {
      const attempt = this.start().catch((err) => {
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
      throw new Error(
        `Not starting SearXNG for another ${Math.ceil((this.cooldownUntil - now) / 1000)}s after ${FAILURE_LIMIT} failed starts. Last error: ${this.lastError}`,
      );
    }
    try {
      const server = await startServer({
        binaryPath: this.options.binaryPath,
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
    this.lastError = message;
    const now = Date.now();
    this.failures = [...this.failures.filter((time) => now - time < FAILURE_WINDOW_MS), now];
    if (this.failures.length < FAILURE_LIMIT) return;
    this.failures = [];
    this.cooldownUntil = now + COOLDOWN_MS;
  }
}
