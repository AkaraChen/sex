import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHmac } from "node:crypto";
import { Deadline } from "@sex/core/deadline.ts";
import { safeFetch } from "@sex/core/net.ts";
import type { Engine } from "../src/engine/engine.ts";
import { type JobRecord, sendWebhook, type Task, type WebhookPayload } from "../src/engine/jobs/index.ts";
import { deliverWebhook, WEBHOOK_MAX_ATTEMPTS, WEBHOOK_RETRY_BASE_MS } from "../src/engine/jobs/webhook.ts";
import { ExtractRequest, WebhookConfig } from "../src/schemas.ts";
import { startMockLlm, testEngine, waitFor } from "./helpers.ts";

interface Hit {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

/** Local fixture server that records every request it receives. */
function serve(route: (req: Request) => Response) {
  const hits: Hit[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      hits.push({
        method: req.method,
        path: new URL(req.url).pathname,
        headers: Object.fromEntries(req.headers),
        body: await req.text(),
      });
      return route(req);
    },
  });
  return { origin: `http://127.0.0.1:${server.port}`, hits, stop: () => server.stop(true) };
}

let target: ReturnType<typeof serve>;
let front: ReturnType<typeof serve>;

beforeAll(() => {
  target = serve(() => new Response("ok"));
  front = serve((req) => {
    const path = new URL(req.url).pathname;
    if (path === "/cross") return Response.redirect(`${target.origin}/landing`, 307);
    if (path === "/same") return Response.redirect(`${front.origin}/landing`, 302);
    if (path === "/post-303") return Response.redirect(`${target.origin}/landing`, 303);
    if (path === "/post-307") return Response.redirect(`${target.origin}/landing`, 307);
    return new Response("ok");
  });
});

afterAll(() => {
  target.stop();
  front.stop();
});

beforeEach(() => {
  target.hits.length = 0;
  front.hits.length = 0;
});

describe("safeFetch redirect handling", () => {
  const credentials = { authorization: "Bearer x", cookie: "c=1", "x-keep": "1" };

  test("cross-origin redirect drops authorization, cookie and proxy-authorization but keeps other headers", async () => {
    await safeFetch(`${front.origin}/cross`, {
      allowPrivateNetwork: true,
      proxy: undefined,
      deadline: Deadline.start(5_000),
      userAgent: "test",
      headers: { ...credentials, "proxy-authorization": "p" },
    });
    expect(front.hits[0]?.headers.authorization).toBe("Bearer x");
    const landed = target.hits.at(-1);
    expect(landed?.path).toBe("/landing");
    expect(landed?.headers.authorization).toBeUndefined();
    expect(landed?.headers.cookie).toBeUndefined();
    expect(landed?.headers["proxy-authorization"]).toBeUndefined();
    expect(landed?.headers["x-keep"]).toBe("1");
  });

  test("same-origin redirect keeps authorization and cookie", async () => {
    await safeFetch(`${front.origin}/same`, {
      allowPrivateNetwork: true,
      proxy: undefined,
      deadline: Deadline.start(5_000),
      userAgent: "test",
      headers: credentials,
    });
    const landed = front.hits.at(-1);
    expect(landed?.path).toBe("/landing");
    expect(landed?.headers.authorization).toBe("Bearer x");
    expect(landed?.headers.cookie).toBe("c=1");
  });

  test("303 turns a POST into a bodiless GET on the next hop", async () => {
    await safeFetch(`${front.origin}/post-303`, {
      allowPrivateNetwork: true,
      proxy: undefined,
      deadline: Deadline.start(5_000),
      userAgent: "test",
      method: "POST",
      body: "payload",
    });
    const landed = target.hits.at(-1);
    expect(landed?.method).toBe("GET");
    expect(landed?.body).toBe("");
  });

  test("307 keeps the POST method and body on the next hop", async () => {
    await safeFetch(`${front.origin}/post-307`, {
      allowPrivateNetwork: true,
      proxy: undefined,
      deadline: Deadline.start(5_000),
      userAgent: "test",
      method: "POST",
      body: "payload",
    });
    const landed = target.hits.at(-1);
    expect(landed?.method).toBe("POST");
    expect(landed?.body).toBe("payload");
  });
});

type WebhookTask = Extract<Task, { type: "webhook" }>;

describe("webhook delivery", () => {
  const SECRET = "s3cret";
  let engine: Engine;
  let strict: Engine;
  let replies: number[];

  beforeAll(() => {
    engine = testEngine({ webhookSecret: SECRET });
    strict = testEngine({ allowPrivateNetwork: false });
  });
  afterAll(async () => {
    await engine.close();
    await strict.close();
  });
  beforeEach(() => {
    replies = [];
    target.hits.length = 0;
  });

  /** A receiver whose status codes come from `replies` (200 once they run out). */
  const hook = serve(() => new Response("x", { status: replies.shift() ?? 200 }));
  afterAll(() => hook.stop());

  const jobWith = (e: Engine, webhook: unknown, kind: "crawl" | "extract" = "crawl") =>
    e.jobs.store.create({ kind, options: { webhook } as Record<string, unknown> });
  const payload = (job: JobRecord): WebhookPayload => ({
    success: true,
    type: "crawl.completed",
    id: job.id,
    webhookId: "w-1",
    data: [],
    metadata: {},
  });
  const attempt = (job: JobRecord, n = 1): WebhookTask => ({
    type: "webhook",
    jobId: job.id,
    taskId: `t-${n}`,
    attempt: n,
    payload: payload(job),
  });
  /** The tasks `deliverWebhook` queues instead of the queue running them. */
  const queued = (e: Engine) => spyOn(e.jobs.scheduler, "add").mockImplementation(async () => {});

  test("a redirect into a private address is refused on the second hop", async () => {
    const redirect = Object.assign(
      async () => new Response(null, { status: 307, headers: { location: "http://169.254.169.254/latest" } }),
      { preconnect: () => {} },
    );
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(redirect);
    const retries = queued(strict);
    try {
      await deliverWebhook(strict, attempt(await jobWith(strict, "http://93.184.216.34/hook")));
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
      retries.mockRestore();
    }
  });

  test("sendWebhook queues a delivery that POSTs the payload with a webhookId, signed with SEX_WEBHOOK_SECRET", async () => {
    const job = await jobWith(engine, { url: `${target.origin}/hook`, headers: { "x-token": "t" }, metadata: { a: 1 } });
    await sendWebhook(engine, job, "completed");
    const hit = await waitFor(() => target.hits[0]);
    expect(hit.method).toBe("POST");
    expect(hit.headers["content-type"]).toBe("application/json");
    expect(hit.headers["x-token"]).toBe("t");
    const body = JSON.parse(hit.body);
    expect(body).toEqual({
      success: true,
      type: "crawl.completed",
      id: job.id,
      webhookId: expect.any(String),
      data: [],
      metadata: { a: 1 },
    });
    expect(hit.headers["x-firecrawl-signature"]).toBe(`sha256=${createHmac("sha256", SECRET).update(hit.body).digest("hex")}`);
  });

  test("without a secret nothing is signed, and a plain string URL works", async () => {
    const unsigned = testEngine();
    try {
      await sendWebhook(unsigned, await jobWith(unsigned, `${target.origin}/hook`), "started");
      const hit = await waitFor(() => target.hits[0]);
      expect(hit.headers["x-firecrawl-signature"]).toBeUndefined();
      expect(JSON.parse(hit.body)).toMatchObject({ success: true, type: "crawl.started", data: [], metadata: {} });
    } finally {
      await unsigned.close();
    }
  });

  test("an event the webhook did not ask for is not sent", async () => {
    const add = queued(engine);
    try {
      await sendWebhook(engine, await jobWith(engine, { url: `${target.origin}/hook`, events: ["completed"] }), "page", [{}]);
      expect(add).not.toHaveBeenCalled();
    } finally {
      add.mockRestore();
    }
  });

  test("a failed event carries success:false and the error", async () => {
    const job = await jobWith(engine, `${target.origin}/hook`);
    await sendWebhook(engine, job, "failed", [], "boom");
    expect(JSON.parse((await waitFor(() => target.hits[0])).body)).toMatchObject({ success: false, type: "crawl.failed", error: "boom" });
  });

  test("a failed attempt is retried as a new task with the same body, after a doubling backoff, up to the last attempt", async () => {
    const job = await jobWith(engine, `${hook.origin}/hook`);
    const add = queued(engine);
    try {
      replies = [500, 429, 503, 502, 500];
      let task = attempt(job);
      const taskIds = new Set([task.taskId]);
      for (let n = 1; n < WEBHOOK_MAX_ATTEMPTS; n++) {
        await deliverWebhook(engine, task);
        const [[next]] = add.mock.calls.at(-1) as [[{ task: WebhookTask; delayMs: number }]];
        expect(next.delayMs).toBe(WEBHOOK_RETRY_BASE_MS * 2 ** (n - 1));
        expect(next.task).toMatchObject({ attempt: n + 1, payload: task.payload });
        expect(taskIds.has(next.task.taskId)).toBe(false);
        taskIds.add(next.task.taskId);
        task = next.task;
      }
      add.mockClear();
      await deliverWebhook(engine, task); // the last attempt fails too: given up
      expect(add).not.toHaveBeenCalled();
      expect(hook.hits.filter((h) => h.path === "/hook")).toHaveLength(WEBHOOK_MAX_ATTEMPTS);
    } finally {
      add.mockRestore();
    }
  });

  test("a receiver that rejects the request (4xx other than 408 / 429) or accepts it is not asked again", async () => {
    const job = await jobWith(engine, `${hook.origin}/hook`);
    const add = queued(engine);
    try {
      replies = [404, 200];
      await deliverWebhook(engine, attempt(job, 1));
      await deliverWebhook(engine, attempt(job, 2));
      expect(add).not.toHaveBeenCalled();
    } finally {
      add.mockRestore();
    }
  });

  test("a task delivered twice POSTs once", async () => {
    const job = await jobWith(engine, `${target.origin}/hook`);
    const task = attempt(job);
    await deliverWebhook(engine, task);
    await deliverWebhook(engine, task);
    expect(target.hits).toHaveLength(1);
  });

  test("a job that is gone has nothing to deliver to", async () => {
    await deliverWebhook(engine, attempt({ ...(await jobWith(engine, "")), id: "gone" }));
    expect(target.hits).toHaveLength(0);
  });
});

describe("webhook schema", () => {
  test("headers may not set the signature header, in any case", () => {
    for (const name of ["X-Firecrawl-Signature", "x-firecrawl-signature"]) {
      expect(WebhookConfig.safeParse({ url: "https://x.test/h", headers: { [name]: "sha256=00" } }).success).toBe(false);
    }
    expect(WebhookConfig.safeParse({ url: "https://x.test/h", headers: { authorization: "Bearer t" } }).success).toBe(true);
  });

  test("extract takes a webhook", () => {
    expect(ExtractRequest.safeParse({ urls: ["https://x.test"], webhook: "https://x.test/h" }).success).toBe(true);
    expect(
      ExtractRequest.safeParse({
        urls: ["https://x.test"],
        webhook: { url: "https://x.test/h", headers: { "X-Firecrawl-Signature": "x" } },
      }).success,
    ).toBe(false);
  });
});

describe("webhook events of jobs", () => {
  let site: ReturnType<typeof serve>;
  let receiver: ReturnType<typeof serve>;
  let llm: ReturnType<typeof startMockLlm>;
  let engine: Engine;
  const events = () => receiver.hits.map((h) => JSON.parse(h.body) as WebhookPayload & { error?: string });
  const eventOf = async (type: string) => waitFor(() => events().find((e) => e.type === type));

  beforeAll(() => {
    site = serve(
      () =>
        new Response(
          `<!doctype html><html><head><title>P</title></head><body><main><article><h1>P</h1>${"<p>Some words in a paragraph, enough to be content. </p>".repeat(8)}</article></main></body></html>`,
          {
            headers: { "content-type": "text/html" },
          },
        ),
    );
    receiver = serve(() => new Response("ok"));
    llm = startMockLlm(() => JSON.stringify({ title: "P" }));
    engine = testEngine({ llmModel: "m", llmBaseUrl: llm.url });
  });
  afterAll(async () => {
    site.stop();
    receiver.stop();
    llm.stop();
    await engine.close();
  });
  beforeEach(() => {
    receiver.hits.length = 0;
  });

  const webhook = () => ({ url: `${receiver.origin}/hook`, metadata: { run: "r1" } });
  const DEAD = "http://127.0.0.1:1/";

  test("a batch page that fails sends a page event with success:false, the error and the url", async () => {
    const { job } = await engine.batchScrape({ urls: [DEAD, `${site.origin}/`], webhook: webhook() });
    const failed = await waitFor(() => events().find((e) => e.type === "batch_scrape.page" && !e.success));
    expect(failed).toMatchObject({ success: false, id: job.id, data: [{ metadata: { sourceURL: DEAD } }], metadata: { run: "r1" } });
    expect(failed.error).toBeString();
    await eventOf("batch_scrape.completed");
    expect(events().filter((e) => e.type === "batch_scrape.page" && e.success)).toHaveLength(1);
  });

  test("a crawl page that fails sends a page event with success:false", async () => {
    await engine.crawl({ url: DEAD, limit: 1, sitemap: "skip", ignoreRobotsTxt: true, webhook: webhook() });
    const failed = await waitFor(() => events().find((e) => e.type === "crawl.page"));
    expect(failed).toMatchObject({ success: false, data: [{ metadata: { sourceURL: DEAD } }] });
  });

  test("an extract sends started and completed, the result in completed", async () => {
    const { job } = await engine.extract({ urls: [`${site.origin}/`], schema: { type: "object" }, webhook: webhook() });
    await eventOf("extract.started");
    const done = await eventOf("extract.completed");
    expect(done).toMatchObject({ success: true, id: job.id, data: [{ title: "P" }] });
    expect(events().map((e) => e.type)).toEqual(["extract.started", "extract.completed"]);
  });

  test("an extract that fails sends failed with the error", async () => {
    await engine.extract({ urls: [DEAD], schema: { type: "object" }, webhook: webhook() });
    const failed = await eventOf("extract.failed");
    expect(failed).toMatchObject({ success: false });
    expect(failed.error).toBeString();
  });

  test("an extract webhook to a private address is refused when the request is made", async () => {
    const strict = testEngine({ allowPrivateNetwork: false, llmModel: "m", llmBaseUrl: llm.url });
    try {
      await expect(
        strict.extract({ urls: ["http://93.184.216.34/"], schema: { type: "object" }, webhook: "http://127.0.0.1/hook" }),
      ).rejects.toThrow("private address");
    } finally {
      await strict.close();
    }
  });
});
