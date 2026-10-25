// All logs go to stderr so stdout stays clean for CLI output and MCP stdio.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 } as const;
type Level = keyof typeof LEVELS;

/** Case-insensitive level lookup; unknown names warn once on stderr and fall back to info. */
function levelFrom(raw: string, source: string): number {
  const name = raw.trim().toLowerCase();
  if (Object.hasOwn(LEVELS, name)) return LEVELS[name as Level];
  process.stderr.write(`${new Date().toISOString()} WARN unknown ${source} "${raw}", using info\n`);
  return LEVELS.info;
}

const envLevel = process.env.SEX_LOG_LEVEL;
let threshold: number = envLevel === undefined || envLevel.trim() === "" ? LEVELS.info : levelFrom(envLevel, "SEX_LOG_LEVEL");

export function setLogLevel(level: string) {
  threshold = levelFrom(level, "log level");
}

/** Simple string tokens stay bare; anything with whitespace, quotes or `=` is JSON-quoted so fields stay parseable. */
function formatValue(v: unknown): string {
  if (typeof v !== "string") return JSON.stringify(v);
  return /[\s"=]/.test(v) ? JSON.stringify(v) : v;
}

function emit(level: Level, msg: string, fields?: Record<string, unknown>) {
  if (LEVELS[level] < threshold) return;
  const extra = fields
    ? ` ${Object.entries(fields)
        .map(([k, v]) => `${k}=${formatValue(v)}`)
        .join(" ")}`
    : "";
  process.stderr.write(`${new Date().toISOString()} ${level.toUpperCase()} ${msg}${extra}\n`);
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit("error", msg, fields),
};
