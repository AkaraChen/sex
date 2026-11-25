import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

/** The time one conversion has. */
export interface ParseTime {
  signal?: AbortSignal;
  deadlineAt?: number;
}

export interface ParserOptions {
  /** The here-docs executable, or its `dist/cli.js`. Default: `here-docs` on PATH. */
  path?: string;
  /** Default 120 s: OCR of a scanned document is slow. */
  timeoutMs?: number;
}

export interface ParsedFile {
  markdown: string;
  warnings: string[];
}

/** here-docs is not installed (or is not runnable). */
export class ParserUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ParserUnavailableError";
  }
}

/** here-docs ran and failed, or answered something that is not its JSON shape. */
export class ParserError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ParserError";
  }
}

/** The conversion ran out of time and was killed. */
export class ParserTimeoutError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ParserTimeoutError";
  }
}

const DEFAULT_TIMEOUT_MS = 120_000;

type Child = {
  stdin: { write(chunk: Uint8Array): unknown; end(): unknown };
  stdout: ReadableStream<Uint8Array> | undefined;
  stderr: ReadableStream<Uint8Array> | undefined;
  exited: Promise<number>;
  kill(signal?: number | string): void;
};

/**
 * `/v2/parse` without a fork: the uploaded bytes go to the here-docs CLI on stdin, and its JSON answer
 * (`{ markdown, warnings }`) comes back. One process per file — OCR is a native engine, so it stays out of sex's
 * process, and nothing of Firecrawl's AGPL scraping binary is involved.
 */
export class Parser {
  constructor(private readonly options: ParserOptions = {}) {}

  describe(): string {
    return this.options.path ?? "here-docs (PATH)";
  }

  /** Converts one file. `filename` is only a format hint for the CLI, never a path sex reads. */
  async parse(file: { bytes: Uint8Array; filename: string }, time?: ParseTime): Promise<ParsedFile> {
    const argv = command(this.options.path);
    let child: Child;
    try {
      child = Bun.spawn([...argv, "-", "--filename", file.filename, "--json"], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      }) as unknown as Child;
    } catch (err) {
      throw new ParserUnavailableError(`Could not run ${argv[0]}: ${message(err)}`, { cause: err });
    }

    let timedOut = false;
    const stop = () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    };
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const deadline = time?.deadlineAt === undefined ? timeoutMs : Math.min(timeoutMs, time.deadlineAt - Date.now());
    const timer = setTimeout(
      () => {
        timedOut = true;
        stop();
      },
      Math.max(1, deadline),
    );
    const onAbort = () => stop();
    time?.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      try {
        child.stdin.write(file.bytes);
        child.stdin.end();
      } catch {
        // The child exited before reading its input; its exit code and stderr say why.
      }
      const [stdout, stderr, code] = await Promise.all([drain(child.stdout), drain(child.stderr), child.exited]);
      if (timedOut || time?.signal?.aborted) {
        throw new ParserTimeoutError(`here-docs did not finish within ${Math.round(deadline)}ms`);
      }
      if (code !== 0) {
        throw new ParserError(`here-docs exited with code ${code}${stderr.trim() ? `: ${tail(stderr)}` : ""}`);
      }
      return answer(stdout);
    } finally {
      clearTimeout(timer);
      time?.signal?.removeEventListener("abort", onAbort);
    }
  }
}

function answer(stdout: string): ParsedFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new ParserError(`here-docs answered something that is not JSON: ${tail(stdout)}`);
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { markdown?: unknown }).markdown !== "string"
  ) {
    throw new ParserError("here-docs answered without a markdown field");
  }
  const warnings = (parsed as { warnings?: unknown }).warnings;
  return {
    markdown: (parsed as { markdown: string }).markdown,
    warnings: Array.isArray(warnings)
      ? warnings
          .map((warning) => (typeof warning === "string" ? warning : (warning as { message?: unknown })?.message))
          .filter((warning): warning is string => typeof warning === "string" && warning.length > 0)
      : [],
  };
}

/** `[executable, ...args]` for a path or a JS file that needs Bun (or Node) to run. */
function command(explicit?: string): string[] {
  if (explicit) return runnable(explicit);
  const found = which("here-docs");
  if (found) return runnable(found);
  throw new ParserUnavailableError(
    "here-docs not found: install it (npm i -g here-docs) or set SEX_PARSE_PATH to its dist/cli.js",
  );
}

function runnable(path: string): string[] {
  if (!/\.(?:[cm]?js|ts)$/.test(path)) return [path];
  for (const runtime of ["bun", "node"]) {
    const found = which(runtime);
    if (found) return [found, path];
  }
  throw new ParserUnavailableError(`No bun or node on PATH to run ${path}`);
}

async function drain(stream: ReadableStream<Uint8Array> | undefined): Promise<string> {
  if (!stream) return "";
  return await new Response(stream).text();
}

function which(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function tail(output: string, lines = 3): string {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-lines)
    .join(" | ");
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
