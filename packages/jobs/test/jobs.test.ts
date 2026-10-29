import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { after, describe, test } from "node:test";
import { signBody, startBatchScrape, startCrawl, WEBHOOK_SIGNATURE_HEADER } from "@searxng-js/sex-jobs";
import { html, jobsContext, page, serve, until } from "./support.ts";

const site = await serve((req: IncomingMessage, res: ServerResponse) => {
  const path = new URL(req.url ?? "/", "http://x").pathname;
  if (path === "/robots.txt") return res.writeHead(404).end();
  if (path === "/") return html(res, page("Home", ["/a", "/b"]));
  if (path === "/a") return html(res, page("Page A", ["/c"]));
  if (path === "/b") return html(res, page("Page B"));
  if (path === "/c") return html(res, page("Page C"));
  html(res, page("Missing"), 404);
});
after(() => site.close());

const hook = { bodies: [] as Array<{ signature?: string; body: string }> };
const receiver = await serve((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    hook.bodies.push({ signature: req.headers[WEBHOOK_SIGNATURE_HEADER.toLowerCase()] as string | undefined, body });
    res.writeHead(200).end();
  });
});
after(() => receiver.close());

describe("jobs on a memory queue", () => {
  test("a batch scrape stores one document per page and completes", async () => {
    const ctx = jobsContext();
    try {
      const { job } = await startBatchScrape(ctx, { urls: [`${site.url}/a`, `${site.url}/b`, "http://127.0.0.1:1/missing"] });
      const done = await until(async () => {
        const j = await ctx.jobs.store.get(job.id);
        return j?.status === "scraping" ? undefined : j;
      }, "the batch");
      assert.equal(done.status, "completed");
      assert.equal(done.completed, 2);
      assert.equal(done.total, 2);
      const docs = (await ctx.jobs.store.documents(job.id, 0, 1e7)).data;
      assert.deepEqual(docs.map((d) => d.metadata?.title).sort(), ["Page A", "Page B"]);
      const errors = await ctx.jobs.store.errors(job.id);
      assert.equal(errors.length, 1);
      assert.equal(errors[0]?.url, "http://127.0.0.1:1/missing");
    } finally {
      await ctx.close();
    }
  });

  test("a crawl follows links from the start page", async () => {
    const ctx = jobsContext();
    try {
      const { job } = await startCrawl(ctx, { url: `${site.url}/`, crawlEntireDomain: true, sitemap: "skip", limit: 10 });
      const done = await until(async () => {
        const j = await ctx.jobs.store.get(job.id);
        return j?.status === "scraping" ? undefined : j;
      }, "the crawl");
      assert.equal(done.status, "completed");
      const titles = (await ctx.jobs.store.documents(job.id, 0, 1e7)).data.map((d) => d.metadata?.title).sort();
      assert.deepEqual(titles, ["Home", "Page A", "Page B", "Page C"]);
    } finally {
      await ctx.close();
    }
  });

  test("a webhook is delivered once, signed when there is a secret", async () => {
    const ctx = jobsContext({ webhookSecret: "s3cret" });
    hook.bodies.length = 0;
    try {
      const { job } = await startBatchScrape(ctx, { urls: [`${site.url}/b`], webhook: { url: receiver.url, events: ["completed"] } });
      await until(() => (hook.bodies.length > 0 ? true : undefined), "the webhook");
      const [delivery] = hook.bodies;
      assert.equal(JSON.parse(delivery?.body ?? "{}").type, "batch_scrape.completed");
      assert.equal(JSON.parse(delivery?.body ?? "{}").id, job.id);
      assert.equal(
        delivery?.signature,
        `sha256=${createHmac("sha256", "s3cret")
          .update(delivery?.body ?? "")
          .digest("hex")}`,
      );
      assert.equal(delivery?.signature, signBody("s3cret", delivery?.body ?? ""));
    } finally {
      await ctx.close();
    }
  });

  test("an extract without an LLM is a 501", async () => {
    const ctx = jobsContext();
    try {
      const { startExtract } = await import("@searxng-js/sex-jobs");
      await assert.rejects(
        startExtract(ctx, { urls: [`${site.url}/a`], prompt: "x" }),
        (err: { status?: number; code?: string }) => err.status === 501 && err.code === "LLM_NOT_CONFIGURED",
      );
    } finally {
      await ctx.close();
    }
  });
});
