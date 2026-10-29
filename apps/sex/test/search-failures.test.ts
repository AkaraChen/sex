import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AppError } from "@searxng-js/sex-errors";
import type { Engine } from "../src/engine/engine.ts";
import { testEngine } from "./helpers.ts";

// A SearXNG stand-in that fails only the news category with HTTP 500.
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const u = new URL(req.url);
    if (u.searchParams.get("pageno") !== "1") return Response.json({ results: [] });
    if (u.searchParams.get("categories") === "news") return new Response("boom", { status: 500 });
    return Response.json({
      results: [{ url: "https://example.test/web", title: "Web hit", content: "from web", category: "general" }],
    });
  },
});
const partialUrl = `http://127.0.0.1:${server.port}`;

let deadEngine: Engine;
let partialEngine: Engine;

beforeAll(() => {
  // Port 1 refuses connections, so every SearXNG call fails immediately.
  deadEngine = testEngine({ searxngUrl: "http://127.0.0.1:1" });
  partialEngine = testEngine({ searxngUrl: partialUrl });
});

afterAll(async () => {
  await deadEngine.close();
  await partialEngine.close();
  server.stop(true);
});

const rejection = async (promise: Promise<unknown>): Promise<AppError> => {
  try {
    await promise;
  } catch (err) {
    return err as AppError;
  }
  throw new Error("expected the promise to reject");
};

describe("search source failures", () => {
  test("fails when every source fails, even with several sources", async () => {
    const err = await rejection(deadEngine.search({ query: "x", sources: ["web", "news"] }));
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe("SEARCH_BACKEND_UNAVAILABLE");
  });

  test("returns partial results with a warning when only some sources fail", async () => {
    const { data, warning } = await partialEngine.search({ query: "x", sources: ["web", "news"] });
    expect(data.web?.[0]?.url).toBe("https://example.test/web");
    expect(data.news).toBeUndefined();
    expect(warning).toContain("news");
  });

  test("an unknown source is rejected instead of running as images", async () => {
    const err = await rejection(partialEngine.search({ query: "x", sources: ["webb" as "web"] }));
    expect(err.code).toBe("BAD_REQUEST");
    expect(err.message).toContain("Unknown source: webb");
  });
});
