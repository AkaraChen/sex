import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sitemapUrls } from "../src/core/map.ts";
import { fetchRobots, parseRobots } from "../src/core/robots.ts";
import { testEngine } from "./helpers.ts";

describe("robots.txt per RFC 9309", () => {
  let server: ReturnType<typeof Bun.serve>;
  const engine = testEngine();
  const origin = () => `http://127.0.0.1:${server.port}`;
  let robotsStatus = 200;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const { pathname } = new URL(req.url);
        if (pathname === "/robots.txt") {
          if (robotsStatus !== 200) return new Response("oops", { status: robotsStatus });
          return new Response("User-agent: *\nDisallow: /private/\nSitemap: /maps/relative.xml\n");
        }
        if (pathname === "/maps/relative.xml") {
          return new Response(
            `<?xml version="1.0"?><urlset>
<url><loc>
  <![CDATA[ https://example.com/cdata-page ]]>
</loc></url>
<url><loc>https://example.com/a?x=1&amp;y=2</loc></url></urlset>`,
            { headers: { "content-type": "application/xml" } },
          );
        }
        return new Response("not found", { status: 404 });
      },
    });
  });

  afterAll(() => server.stop(true));

  test("a 5xx robots.txt disallows everything", async () => {
    robotsStatus = 503;
    const robots = await fetchRobots(engine, origin(), "sex");
    expect(robots.isAllowed(`${origin()}/anything`)).toBe(false);
  });

  test("a 404 robots.txt allows everything", async () => {
    robotsStatus = 404;
    const robots = await fetchRobots(engine, origin(), "sex");
    expect(robots.isAllowed(`${origin()}/anything`)).toBe(true);
  });

  test("an unreachable robots.txt allows everything", async () => {
    const robots = await fetchRobots(engine, "http://127.0.0.1:1", "sex");
    expect(robots.isAllowed("http://127.0.0.1:1/anything")).toBe(true);
  });

  test("an empty User-agent token matches no crawler", () => {
    const robots = parseRobots("User-agent:\nDisallow: /\n\nUser-agent: *\nAllow: /\n", "sex");
    expect(robots.isAllowed("https://example.com/x")).toBe(true);
  });

  test("relative Sitemap lines are resolved and CDATA with whitespace is unwrapped", async () => {
    robotsStatus = 200;
    const urls = await sitemapUrls(engine, origin(), 100);
    expect(urls).toContain("https://example.com/cdata-page");
    expect(urls).toContain("https://example.com/a?x=1&y=2");
  });
});
