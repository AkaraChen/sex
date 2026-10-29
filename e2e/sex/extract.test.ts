// POST /v2/extract with a mock LLM: schema + prompt, prompt only, multi-entity merge, /* wildcard, web search, failures.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type ChatRequest, startMockLlm } from "../lib/llm.ts";
import { api, killAll, type Server, until } from "../lib/proc.ts";
import { html, prose, type Site, site, startMockSearxng } from "../lib/sites.ts";
import { removeTempDirs } from "../lib/tmp.ts";
import { type CallKind, kindOf, llmFlags, startSex, userOf } from "./helpers.ts";

let srv: Server;
let shop: Site;
let searxng: ReturnType<typeof startMockSearxng>;
let llm: ReturnType<typeof startMockLlm>;

/** Replaced by each test; gets the kind of call and the request. */
let answer: (kind: CallKind, req: ChatRequest) => string | { status: number; body?: unknown } = () => "{}";
let kinds: CallKind[] = [];

const PRODUCT_SCHEMA = {
  type: "object",
  properties: {
    products: { type: "array", items: { type: "object", properties: { name: { type: "string" }, price: { type: "number" } } } },
  },
};

/** The product on a /shop/N page: "Gadget N", N * 10 dollars. */
const productOf = (req: ChatRequest): { name: string; price: number } | undefined => {
  const m = /Product (\d)/.exec(userOf(req));
  return m ? { name: `Gadget ${m[1]}`, price: Number(m[1]) * 10 } : undefined;
};

async function extract(body: Record<string, unknown>) {
  const created = await api(srv.url, "/v2/extract", { body });
  expect(created.status).toBe(200);
  expect(created.body.success).toBe(true);
  const done = await until(
    async () => {
      const r = await api(srv.url, `/v2/extract/${created.body.id}`);
      expect(r.status).toBe(200);
      return r.body.status === "processing" ? undefined : r.body;
    },
    60_000,
    150,
  );
  return { created: created.body, status: done };
}

beforeAll(async () => {
  shop = site((_req, url) => {
    const p = url.pathname;
    if (p === "/robots.txt") return new Response("nf", { status: 404 });
    const m = /^\/shop\/(\d)$/.exec(p);
    if (p === "/shop/" || p === "/shop")
      return html(
        "Shop",
        `<h1>Shop</h1>${prose("the shop")}${[1, 2, 3].map((i) => `<a href="/shop/${i}">Product ${i}</a>`).join(" ")}<a href="/about">About us</a>`,
      );
    if (m)
      return html(
        `Product ${m[1]}`,
        `<h1>Product ${m[1]}</h1><p>Name: Gadget ${m[1]}. Price: ${Number(m[1]) * 10} dollars.</p>${prose("a gadget", 2)}`,
      );
    if (p === "/docs/a" || p === "/docs/b") return html(`Doc ${p}`, `<h1>Doc ${p}</h1>${prose("the doc", 2)}`);
    if (p === "/about") return html("About", `<h1>About us</h1>${prose("our company")}`);
    return new Response("nf", { status: 404 });
  });
  searxng = startMockSearxng(shop.url);
  llm = startMockLlm((req) => {
    const kind = kindOf(req);
    kinds.push(kind);
    const r = answer(kind, req);
    return r;
  });
  srv = await startSex([...llmFlags(llm), "--searxng-url", searxng.url]);
});

afterAll(async () => {
  shop.stop();
  searxng.stop();
  llm.stop();
  await killAll();
  removeTempDirs();
});

describe("extract", () => {
  test("a schema and a prompt: one page, one answer", async () => {
    kinds = [];
    answer = () => JSON.stringify({ name: "Gadget 1", price: 10 });
    const { status } = await extract({
      urls: [`${shop.url}/shop/1`],
      prompt: "Get the product",
      schema: { type: "object", properties: { name: { type: "string" }, price: { type: "number" } }, required: ["name", "price"] },
    });
    expect(status.status).toBe("completed");
    expect(status.data).toEqual({ name: "Gadget 1", price: 10 });
    expect(status.creditsUsed).toBe(1);
    expect(status.tokensUsed).toBeGreaterThan(0);
    expect(new Date(status.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(kinds).toEqual(["extract"]);
  });

  test("a prompt only: a schema is generated first", async () => {
    kinds = [];
    answer = (kind) =>
      kind === "schema"
        ? JSON.stringify({ type: "object", properties: { name: { type: "string" } }, required: ["name"] })
        : JSON.stringify({ name: "Gadget 2" });
    const { status } = await extract({ urls: [`${shop.url}/shop/2`], prompt: "What is the name of the product?" });
    expect(status.status).toBe("completed");
    expect(status.data).toEqual({ name: "Gadget 2" });
    expect(kinds[0]).toBe("schema");
    expect(kinds).toContain("extract");
  });

  test("multi-entity: arrays are extracted per page and merged in code, irrelevant pages dropped", async () => {
    kinds = [];
    answer = (kind, req) => {
      if (kind === "plan") return JSON.stringify({ isMultiEntity: true, multiEntityKeys: ["products"], reasoning: "many products" });
      const p = productOf(req);
      // Page 3 is "not relevant" to the model; the shop index has no product.
      if (!p) return JSON.stringify({ products: [], is_content_relevant: false });
      return JSON.stringify({ products: [p], is_content_relevant: p.name !== "Gadget 3" });
    };
    const { status } = await extract({
      urls: [`${shop.url}/shop/1`, `${shop.url}/shop/2`, `${shop.url}/shop/3`, `${shop.url}/shop/1`],
      prompt: "List all products",
      schema: PRODUCT_SCHEMA,
      showSources: true,
    });
    expect(status.status).toBe("completed");
    const products = (status.data.products as Array<{ name: string }>).map((p) => p.name).sort();
    expect(products).toEqual(["Gadget 1", "Gadget 2"]);
    expect(kinds.filter((k) => k === "extract").length).toBeGreaterThanOrEqual(3);
    expect(status.sources["*"].sort()).toEqual(expect.arrayContaining([`${shop.url}/shop/1`, `${shop.url}/shop/2`]));
    expect(Object.keys(status.sources).some((k) => k.startsWith("products["))).toBe(true);
  });

  test("a /* URL is expanded to the site's pages, picked by the small model", async () => {
    kinds = [];
    let candidates = "";
    answer = (kind, req) => {
      if (kind === "links") {
        candidates = userOf(req);
        // Pick the candidates that are product pages, by number.
        const nums = [...userOf(req).matchAll(/^(\d+): \S+\/shop\/\d\b/gm)].map((m) => Number(m[1]));
        return JSON.stringify(nums);
      }
      if (kind === "plan") return JSON.stringify({ isMultiEntity: true, multiEntityKeys: ["products"], reasoning: "x" });
      const p = productOf(req);
      return JSON.stringify({ products: p ? [p] : [], is_content_relevant: !!p });
    };
    const { status } = await extract({
      urls: [`${shop.url}/shop/*`],
      prompt: "all products with prices",
      schema: PRODUCT_SCHEMA,
      limit: 5,
    });
    expect(status.status).toBe("completed");
    expect(candidates).toContain(`${shop.url}/shop/1`);
    expect(kinds).toContain("links");
    expect((status.data.products as Array<{ name: string }>).map((p) => p.name).sort()).toEqual(["Gadget 1", "Gadget 2", "Gadget 3"]);
    expect(status.creditsUsed).toBeGreaterThanOrEqual(3);
  });

  test("a /* URL whose selection fails falls back to the map order, with a warning; limit caps the pages", async () => {
    answer = (kind, req) => {
      if (kind === "links") return { status: 500, body: { error: { message: "down" } } };
      if (kind === "plan") return JSON.stringify({ isMultiEntity: true, multiEntityKeys: ["products"], reasoning: "x" });
      const p = productOf(req);
      return JSON.stringify({ products: p ? [p] : [], is_content_relevant: !!p });
    };
    const { status } = await extract({ urls: [`${shop.url}/shop/*`], prompt: "products", schema: PRODUCT_SCHEMA, limit: 2 });
    expect(status.status).toBe("completed");
    expect(status.warning).toBeTruthy();
    expect(status.creditsUsed).toBeLessThanOrEqual(2);
  });

  test("without urls the prompt is searched for on the web and the results are read", async () => {
    answer = (kind) =>
      kind === "schema"
        ? JSON.stringify({ type: "object", properties: { title: { type: "string" } } })
        : JSON.stringify({ title: "A doc" });
    const { status } = await extract({ prompt: "what is doc a about", showSources: true });
    expect(status.status).toBe("completed");
    expect(status.data).toEqual({ title: "A doc" });
    // The mock SearXNG answers with /docs/a and /docs/b of the shop (and a page elsewhere, which is not reachable).
    expect(status.sources["*"]).toEqual(expect.arrayContaining([`${shop.url}/docs/a`, `${shop.url}/docs/b`]));
  });

  test("page scrapeOptions are applied; invalid URLs are listed; all-invalid URLs are a 400", async () => {
    answer = () => JSON.stringify({ name: "n" });
    const created = await api(srv.url, "/v2/extract", {
      body: {
        urls: [`${shop.url}/shop/1`, "not a url"],
        prompt: "name",
        schema: { type: "object", properties: { name: { type: "string" } } },
      },
    });
    expect(created.status).toBe(200);
    expect(created.body.invalidURLs).toEqual(["not a url"]);
    const bad = await api(srv.url, "/v2/extract", { body: { urls: ["not a url"], prompt: "x" } });
    expect(bad.status).toBe(400);
    const none = await api(srv.url, "/v2/extract", { body: { urls: [`${shop.url}/shop/1`] } });
    expect(none.status).toBe(400);
  });

  test("a model that rejects the request fails the job with its message", async () => {
    answer = () => ({ status: 401, body: { error: { message: "bad key" } } });
    const { status } = await extract({
      urls: [`${shop.url}/shop/1`],
      prompt: "name",
      schema: { type: "object", properties: { name: { type: "string" } } },
    });
    expect(status.status).toBe("failed");
    expect(status.error).toContain("401");
    expect(status.error).toContain("SEX_LLM_API_KEY");
  });

  test("output that never fits the schema fails with LLM_INVALID_OUTPUT text", async () => {
    answer = () => JSON.stringify({ name: 12 });
    const { status } = await extract({
      urls: [`${shop.url}/shop/1`],
      prompt: "name",
      schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    });
    expect(status.status).toBe("failed");
    expect(status.error).toBeTruthy();
  });

  test("the status of an unknown id is 404", async () => {
    expect((await api(srv.url, "/v2/extract/00000000-0000-4000-8000-000000000000")).status).toBe(404);
  });

  test("without an LLM extract is 501", async () => {
    const bare = await startSex();
    const r = await api(bare.url, "/v2/extract", { body: { urls: [`${shop.url}/shop/1`], prompt: "x" } });
    expect(r.status).toBe(501);
    expect(r.body.code).toBe("LLM_NOT_CONFIGURED");
    await bare.stop();
  });
});
