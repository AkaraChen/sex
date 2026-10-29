import assert from "node:assert/strict";

/** The named fields of an error (or any object) equal `expected`: `assert.partialDeepStrictEqual` wants the same prototype, which an `Error` is not. */
export function assertFields(actual: unknown, expected: Record<string, unknown>): void {
  const picked = Object.fromEntries(Object.keys(expected).map((k) => [k, (actual as Record<string, unknown> | undefined)?.[k]]));
  assert.deepEqual(picked, expected);
}
