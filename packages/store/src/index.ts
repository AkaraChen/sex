// Errors are this class (bundled in every package, recognised across them by AppError.isInstance, never instanceof).
export { AppError, type ErrorCode } from "@searxng-js/sex-errors";
export { type PageCacheOptions, SqliteScrapeCache } from "./cache.ts";
export { markdownDiff } from "./change-diff.ts";
export { SqliteChangeTracker } from "./change-tracker.ts";
