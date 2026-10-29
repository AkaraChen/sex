// Errors are this class (bundled in every package, recognised across them by AppError.isInstance, never instanceof).
export { AppError, type ErrorCode } from "@searxng-js/sex-errors";
export * from "./egress.ts";
export * from "./net.ts";
export * from "./rewrite.ts";
