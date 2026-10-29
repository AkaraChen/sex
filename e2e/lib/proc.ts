import type { Subprocess } from "bun";

/** No test talks to a real SearXNG unless it says so: a dead port makes a search fail fast instead of starting one. */
export const DEAD_SEARXNG = "http://127.0.0.1:9";

export type Env = Record<string, string | undefined>;

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** stdout parsed as JSON (throws with the output when it is not). */
  json<T = any>(): T;
}

const live = new Set<Subprocess>();

/** Kills every process this file started and that is still running (suites call it in `afterAll`). */
export async function killAll(): Promise<void> {
  const procs = [...live];
  for (const p of procs) p.kill("SIGKILL");
  await Promise.all(procs.map((p) => p.exited));
}

process.on("exit", () => {
  for (const p of live) p.kill("SIGKILL");
});

/**
 * The environment a binary runs with: the caller's, minus anything `SEX_*` from the developer's shell, plus `env`
 * (a value of `undefined` removes the variable). `SEX_SEARXNG_URL` defaults to a dead port.
 */
export function envFor(env: Env = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("SEX_")) out[k] = v;
  out.SEX_SEARXNG_URL = DEAD_SEARXNG;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  return out;
}

/** Runs a CLI command to completion. */
export async function run(
  binary: string,
  args: string[],
  opts: { env?: Env; timeoutMs?: number; stdin?: string; cwd?: string } = {},
): Promise<RunResult> {
  const proc = Bun.spawn([binary, ...args], {
    env: envFor(opts.env),
    cwd: opts.cwd,
    stdin: opts.stdin === undefined ? "ignore" : new TextEncoder().encode(opts.stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  live.add(proc);
  const timer = setTimeout(() => proc.kill("SIGKILL"), opts.timeoutMs ?? 120_000);
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  live.delete(proc);
  return {
    code,
    stdout,
    stderr,
    json() {
      try {
        return JSON.parse(stdout);
      } catch {
        throw new Error(`stdout is not JSON (exit ${code}):\n${stdout.slice(0, 2000)}\nstderr:\n${stderr.slice(0, 2000)}`);
      }
    },
  };
}

export interface Server {
  url: string;
  proc: Subprocess;
  /** Everything the server wrote to stderr so far. */
  stderr(): string;
  /** Sends `signal` (default SIGTERM) and waits for the exit code. */
  stop(signal?: NodeJS.Signals): Promise<number>;
}

/**
 * Starts `<binary> serve --port 0` and resolves once it logs its URL. Extra CLI flags go in `args`
 * (e.g. `--data-dir`, `--allow-private-network`, `--lightpanda`).
 */
export async function serve(binary: string, args: string[] = [], opts: { env?: Env; startupMs?: number } = {}): Promise<Server> {
  const proc = Bun.spawn([binary, "serve", "--host", "127.0.0.1", "--port", "0", ...args], {
    env: envFor(opts.env),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  live.add(proc);
  let log = "";
  const decoder = new TextDecoder();
  const url = new Promise<string>((resolve, reject) => {
    (async () => {
      for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) {
        log += decoder.decode(chunk, { stream: true });
        const m = /http server listening url=(\S+)/.exec(log);
        if (m) resolve(m[1] as string);
      }
      reject(new Error(`serve exited before listening:\n${log.slice(-4000)}`));
    })().catch(reject);
  });
  const timer = setTimeout(() => proc.kill("SIGKILL"), opts.startupMs ?? 60_000);
  try {
    const base = await url;
    return {
      url: base,
      proc,
      stderr: () => log,
      async stop(signal: NodeJS.Signals = "SIGTERM") {
        proc.kill(signal);
        const code = await proc.exited;
        live.delete(proc);
        return code;
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface ApiResponse<T = any> {
  status: number;
  headers: Headers;
  body: T;
}

/** JSON request against a server; the body is parsed when the reply is JSON, else returned as text. */
export async function api<T = any>(
  base: string,
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<ApiResponse<T>> {
  const res = await fetch(new URL(path, base), {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: { ...(init.body === undefined ? {} : { "content-type": "application/json" }), ...init.headers },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  let body: unknown = text;
  if ((res.headers.get("content-type") ?? "").includes("json")) {
    try {
      body = JSON.parse(text);
    } catch {
      // keep the text
    }
  }
  return { status: res.status, headers: res.headers, body: body as T };
}

/** Polls `fn` until it returns something other than `undefined`. */
export async function until<T>(fn: () => Promise<T | undefined> | T | undefined, timeoutMs = 60_000, everyMs = 250): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`condition not met within ${timeoutMs} ms`);
    await Bun.sleep(everyMs);
  }
}
