import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/** A firecrawl-local child process that answered `/health`. */
export interface LocalServer {
  /** `http://host:port`, no trailing slash. */
  url: string;
  /** Bearer token its API expects. */
  token: string;
  pid: number;
  /** Resolves with the exit code. Never rejects. */
  exited: Promise<number>;
  /** SIGTERM, then SIGKILL after 5 s. */
  stop(): Promise<void>;
}

export interface StartServerOptions {
  /** The executable. Default: the embedded one, else `firecrawl-local` on PATH. */
  binaryPath?: string;
  /** Arguments after `serve --host --port --token`. */
  args?: readonly string[];
  /** Default: a free port on 127.0.0.1. */
  port?: number;
  /** Default: 127.0.0.1. */
  host?: string;
  /** Default: random per start. */
  token?: string;
  env?: Record<string, string | undefined>;
  /** How long to wait for `/health`. Default: 30 s. */
  timeoutMs?: number;
  onOutput?: (line: string) => void;
}

export class StartServerError extends Error {
  readonly output: string;

  constructor(message: string, output = "", options?: ErrorOptions) {
    super(message, options);
    this.name = "StartServerError";
    this.output = output;
  }
}

/** A binary registered by the build (`registerEmbedded`) for embedding in a compiled executable. */
let embedded: { version: string; sha256: string; file: string } | undefined;

/**
 * Makes the binary at `file` available to `startServer` inside a compiled Bun executable. `file` is the path a
 * `with { type: "file" }` import resolves to (`/$bunfs/...`), `version` and `sha256` name its cache directory and
 * verify the bytes. The build calls this before importing the app.
 */
export function registerEmbedded(version: string, sha256: string, file: string): void {
  embedded = { version, sha256, file };
}

const START_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 5_000;

/** The executable `startServer` spawns: an explicit path, the embedded one, else `firecrawl-local` on PATH. */
export async function resolveBinary(explicit?: string): Promise<string> {
  if (explicit) return explicit;
  if (embedded) return extract(embedded);
  for (const name of ["firecrawl-local", "firecrawl-local.exe"]) {
    const found = which(name);
    if (found) return found;
  }
  throw new StartServerError(
    "firecrawl-local not found: pass binaryPath, put `firecrawl-local` on PATH, or include it in a build (registerEmbedded)",
  );
}

/** Spawns `firecrawl-local serve`, waits for `/health`, and returns the instance. Kills the child if it never gets there. */
export async function startServer(options: StartServerOptions = {}): Promise<LocalServer> {
  const binary = await resolveBinary(options.binaryPath);
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? (await freePort());
  const token = options.token ?? randomBytes(24).toString("base64url");
  const url = `http://${host}:${port}`;
  const argv = command(binary, [
    "serve",
    "--host",
    host,
    "--port",
    String(port),
    "--token",
    token,
    ...(options.args ?? []),
  ]);

  const lines: string[] = [];
  const tail = () => lines.slice(-5).join(" | ");
  const note = (line: string) => {
    if (!line) return;
    lines.push(line);
    if (lines.length > 100) lines.shift();
    options.onOutput?.(line);
  };

  let child: Child;
  try {
    child = spawn(argv, { ...process.env, ...options.env });
  } catch (err) {
    throw new StartServerError(`Could not start ${binary}: ${message(err)}`, "", { cause: err });
  }

  const exited = child.exited;
  void pump(child.stdout, note);
  void pump(child.stderr, note);

  const timeoutMs = options.timeoutMs ?? START_TIMEOUT_MS;
  try {
    await Promise.race([
      waitForHealth(url, token, timeoutMs),
      exited.then((code) => {
        throw new StartServerError(
          `firecrawl-local exited with code ${code} before it was ready${tail() ? `: ${tail()}` : ""}`,
        );
      }),
    ]);
  } catch (err) {
    kill(child, "SIGKILL");
    throw err instanceof StartServerError ? err : new StartServerError(message(err), tail(), { cause: err });
  }

  return { url, token, pid: child.pid, exited, stop: () => stop(child, exited) };
}

type Child = {
  pid: number;
  exitCode: number | null;
  exited: Promise<number>;
  kill(signal?: number | string): void;
  stdout: ReadableStream<Uint8Array> | undefined;
  stderr: ReadableStream<Uint8Array> | undefined;
};

function spawn(argv: readonly string[], env: Record<string, string | undefined>): Child {
  const child = Bun.spawn([...argv], {
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return child as unknown as Child;
}

/** On Linux `setpriv --pdeathsig TERM` makes the child die with sex even on SIGKILL. */
function command(binary: string, args: string[]): string[] {
  if (process.platform === "linux") {
    const setpriv = which("setpriv");
    if (setpriv) return [setpriv, "--pdeathsig", "TERM", "--", binary, ...args];
  }
  return [binary, ...args];
}

async function pump(stream: ReadableStream<Uint8Array> | undefined, note: (line: string) => void): Promise<void> {
  if (!stream) return;
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) note(line.trimEnd());
    }
  } catch {
    // The pipe closed with the process; whatever was read is enough.
  }
  if (buffer) note(buffer.trimEnd());
}

async function waitForHealth(url: string, token: string, timeoutMs: number): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const response = await fetch(`${url}/health`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) return;
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new StartServerError(`firecrawl-local did not answer /health within ${timeoutMs}ms`);
}

async function stop(child: Child, exited: Promise<number>): Promise<void> {
  if (child.exitCode !== null) return;
  kill(child, "SIGTERM");
  const forced = setTimeout(() => kill(child, "SIGKILL"), STOP_TIMEOUT_MS);
  await exited.catch(() => 0);
  clearTimeout(forced);
}

function kill(child: Child, signal: string): void {
  try {
    child.kill(signal);
  } catch {
    // Already gone.
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new StartServerError("Could not find a free port"))));
    });
  });
}

function which(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

async function extract(binary: { version: string; sha256: string; file: string }): Promise<string> {
  const dir = join(
    process.env.XDG_CACHE_HOME || join(homedir(), ".cache"),
    "sex",
    `firecrawl-local-${binary.version}-${binary.sha256.slice(0, 12)}`,
  );
  const path = join(dir, "firecrawl-local");
  if (existsSync(path)) return path;
  await mkdir(dir, { recursive: true });
  const bytes = new Uint8Array(await Bun.file(binary.file).arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== binary.sha256) {
    throw new StartServerError(`The embedded firecrawl-local does not match its SHA-256 (got ${digest})`);
  }
  await writeFile(path, bytes, { mode: 0o755 });
  await chmod(path, 0o755);
  return path;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
