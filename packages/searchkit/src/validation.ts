import { SearchError } from "./errors.ts";
import type { ProviderResponse, SearchRequest, ValidatedSearchRequest } from "./types.ts";

/** A JSON object from a provider, or the failure that says it is not one. */
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SearchError("invalid_response");
  return value as Record<string, unknown>;
}
export function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new SearchError("invalid_response");
  return value;
}
export function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new SearchError("invalid_response");
  return value;
}
export function optionalStrings(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
    throw new SearchError("invalid_response");
  return [...value];
}
export function resultUrl(value: unknown): string {
  if (typeof value !== "string" || !/^https?:\/\/[^/\\]/i.test(value)) throw new SearchError("invalid_response");
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new SearchError("invalid_response");
  return value;
}
export function requestId(value: unknown): string | undefined {
  const id = optionalString(value);
  if (id !== undefined && !/^[a-zA-Z0-9_.:/-]{1,256}$/.test(id)) throw new SearchError("invalid_response");
  return id;
}
export function positiveInteger(value: number | undefined, fallback: number): number {
  const result = value === undefined ? fallback : value;
  if (!Number.isInteger(result) || result < 1) throw new SearchError("configuration");
  return result;
}
export function exactFields(
  value: object,
  allowed: readonly string[],
  code: "invalid_request" | "configuration" = "invalid_request",
): void {
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string" || !allowed.includes(key)))
    throw new SearchError(code);
}

/** Adapter options are exact too: a typo'd option is a configuration error, not a silently ignored one. */
export function configuration(value: unknown, fields: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SearchError("configuration");
  exactFields(value, fields, "configuration");
}

function domains(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    !value.length ||
    !value.every(
      (domain) =>
        typeof domain === "string" &&
        domain.length <= 253 &&
        domain.split(".").length >= 2 &&
        domain.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)),
    )
  )
    throw new SearchError("invalid_request");
  return Object.freeze([...new Set(value.map((domain) => domain.toLowerCase()))]);
}

/** The only request shape the contract carries; anything else about it is a caller bug, checked before dispatch. */
export function validateRequest(input: SearchRequest): ValidatedSearchRequest {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new SearchError("invalid_request");
  exactFields(input, ["query", "limit", "includeDomains", "excludeDomains"]);
  if (typeof input.query !== "string" || !input.query.trim()) throw new SearchError("invalid_request");
  const limit = input.limit ?? 5;
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new SearchError("invalid_request");
  const includeDomains = domains(input.includeDomains);
  const excludeDomains = domains(input.excludeDomains);
  if (includeDomains?.some((domain) => excludeDomains?.includes(domain))) throw new SearchError("invalid_request");
  return Object.freeze({
    query: input.query,
    limit,
    ...(includeDomains ? { includeDomains } : {}),
    ...(excludeDomains ? { excludeDomains } : {}),
  });
}

/** Kept for custom providers; our adapters build responses that already fit, so createSearch does not re-check them. */
export function providerResponseFits(value: unknown): value is ProviderResponse {
  const candidate = value as ProviderResponse | null | undefined;
  return !!candidate && Array.isArray(candidate.results) && Array.isArray(candidate.warnings);
}
