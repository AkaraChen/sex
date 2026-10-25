// All logs go to stderr so stdout stays clean for CLI output and MCP stdio.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 } as const;
type Level = keyof typeof LEVELS;

let threshold: number = LEVELS[(process.env.SEX_LOG_LEVEL as Level) ?? "info"] ?? LEVELS.info;

export function setLogLevel(level: string) {
  if (level in LEVELS) threshold = LEVELS[level as Level];
}

function emit(level: Level, msg: string, fields?: Record<string, unknown>) {
  if (LEVELS[level] < threshold) return;
  const extra = fields
    ? ` ${Object.entries(fields)
        .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
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
