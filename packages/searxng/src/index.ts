// Errors are this class (bundled in every package, recognised across them by AppError.isInstance, never instanceof).
export { AppError, type ErrorCode } from "@searxng-js/sex-errors";
export { type SearxngOptions, SearxngService } from "./searxng.ts";
export { generatedSettings, proxiedSettings, proxyHost, redactProxy } from "./searxng-settings.ts";
