import { expect, test } from "bun:test";
import { resolveConfig } from "../src/config.ts";
import { createJobBackend } from "../src/core/jobs/index.ts";

test("job store reads fail fast instead of hanging when Redis is unreachable", async () => {
  const config = resolveConfig({ redisUrl: "redis://127.0.0.1:1" }, {}, {});
  const backend = createJobBackend(config);
  try {
    const started = Date.now();
    await expect(backend.store.get("missing")).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(8000);
  } finally {
    await backend.close();
  }
}, 15_000);
