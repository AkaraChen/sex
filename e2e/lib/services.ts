/**
 * External services some suites need (CI starts them, see .github/workflows/e2e.yml). Locally a missing one skips
 * the tests that need it; with `SEX_E2E_REQUIRE_ALL=1` (CI) it fails them instead.
 */
const REQUIRE_ALL = process.env.SEX_E2E_REQUIRE_ALL === "1";

function need<T>(name: string, value: T | undefined): T | undefined {
  if (value === undefined && REQUIRE_ALL) throw new Error(`${name} is required (SEX_E2E_REQUIRE_ALL=1)`);
  return value;
}

/** A Chrome with remote debugging, e.g. http://127.0.0.1:9222 (`SEX_E2E_CDP_URL`). */
export const cdpUrl = (): string | undefined => need("SEX_E2E_CDP_URL", process.env.SEX_E2E_CDP_URL || undefined);

/** An S3-compatible server (`SEX_E2E_S3_ENDPOINT`, `SEX_E2E_S3_ACCESS_KEY_ID`, `SEX_E2E_S3_SECRET_ACCESS_KEY`). */
export function s3(): { endpoint: string; accessKeyId: string; secretAccessKey: string } | undefined {
  const endpoint = process.env.SEX_E2E_S3_ENDPOINT || undefined;
  const accessKeyId = process.env.SEX_E2E_S3_ACCESS_KEY_ID || undefined;
  const secretAccessKey = process.env.SEX_E2E_S3_SECRET_ACCESS_KEY || undefined;
  if (!endpoint || !accessKeyId || !secretAccessKey) return need("SEX_E2E_S3_*", undefined);
  return { endpoint, accessKeyId, secretAccessKey };
}
