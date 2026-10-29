// The embedded Lightpanda browser (`--lightpanda`): JS rendering, waitFor, actions, headers, fallbacks.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { killAll, type Server } from "../lib/proc.ts";
import { html, prose, type Site, site, staticSite } from "../lib/sites.ts";
import { removeTempDirs } from "../lib/tmp.ts";
import { scrape, startSex } from "./helpers.ts";

let browser: Server;
let plain: Server;
const sites: Site[] = [];
const own = <T extends Site>(s: T): T => {
  sites.push(s);
  return s;
};

/** Content that only exists after the page's script ran (right away, and 2.5 s later). */
const jsPage = own(
  site((_req, url) => {
    if (url.pathname === "/blank") return html("Blank", `${prose("blanked")}<script>document.body.innerHTML = ""</script>`);
    return html(
      "Rendered",
      `<h1 id="t">server text</h1>${prose("rendering")}
<script>
document.getElementById("t").textContent = "rendered by script";
setTimeout(() => document.body.insertAdjacentHTML("beforeend", "<p>late arrival text</p>"), 2500);
</script>`,
    );
  }),
);

const formPage = own(
  site(() =>
    html(
      "Form",
      `<button id="b" onclick="this.textContent = 'clicked'">press me</button>
<input id="i" onkeydown="if (event.key === 'Enter') document.title = 'entered ' + this.value">
<p id="w">w</p>${prose("form")}
<div style="height: 4000px"></div>
<script>window.onscroll = () => { document.getElementById("w").textContent = "scrolled" }</script>`,
    ),
  ),
);

const widthPage = own(
  site(() =>
    html(
      "Width",
      `${prose("viewport")}<p id="w"></p><script>document.getElementById("w").textContent = "innerWidth=" + innerWidth</script>`,
    ),
  ),
);

beforeAll(async () => {
  browser = await startSex(["--lightpanda"]);
  plain = await startSex();
});

afterAll(async () => {
  for (const s of sites) s.stop();
  await killAll();
  removeTempDirs();
});

describe("rendering", () => {
  test("a page that builds its content in JS is rendered, and is not without the browser", async () => {
    const withBrowser = await scrape(browser, { url: `${jsPage.url}/`, formats: ["markdown"] });
    expect(withBrowser.status).toBe(200);
    expect(withBrowser.body.data.markdown).toContain("rendered by script");
    expect(withBrowser.body.data.markdown).not.toContain("server text");
    expect(withBrowser.body.data.metadata.statusCode).toBe(200);

    const without = await scrape(plain, { url: `${jsPage.url}/`, formats: ["markdown"] });
    expect(without.status).toBe(200);
    expect(without.body.data.markdown).toContain("server text");
    expect(without.body.data.markdown).not.toContain("rendered by script");
  });

  test("fastMode skips the browser", async () => {
    const r = await scrape(browser, { url: `${jsPage.url}/`, formats: ["markdown"], fastMode: true });
    expect(r.status).toBe(200);
    expect(r.body.data.markdown).toContain("server text");
  });

  test("html and links formats come from the rendered page", async () => {
    const r = await scrape(browser, { url: `${jsPage.url}/`, formats: ["html", "links"] });
    expect(r.status).toBe(200);
    expect(r.body.data.html).toContain("rendered by script");
  });

  test("waitFor lets late content arrive", async () => {
    const early = await scrape(browser, { url: `${jsPage.url}/`, formats: ["markdown"] });
    expect(early.body.data.markdown).not.toContain("late arrival text");
    const late = await scrape(browser, { url: `${jsPage.url}/`, formats: ["markdown"], waitFor: 4000 });
    expect(late.status).toBe(200);
    expect(late.body.data.markdown).toContain("late arrival text");
  }, 60_000);

  test("without a browser waitFor and mobile are ignored, with a warning", async () => {
    const r = await scrape(plain, { url: `${jsPage.url}/`, formats: ["markdown"], waitFor: 100, mobile: true });
    expect(r.status).toBe(200);
    expect(r.body.data.warning).toContain("waitFor is ignored without a browser");
    expect(r.body.data.warning).toContain("-- your scrape may be partial");
  });

  test("waitFor above timeout / 2 is accepted with a warning; waitFor + wait above 60 s is a 400", async () => {
    const ok = await scrape(browser, { url: `${formPage.url}/`, formats: ["markdown"], waitFor: 1500, timeout: 2500 });
    expect(ok.status).toBe(200);
    expect(ok.body.data.warning).toContain("waitFor is more than half of timeout");
    const bad = await scrape(browser, {
      url: `${formPage.url}/`,
      waitFor: 40000,
      actions: [{ type: "wait", milliseconds: 30000 }],
    });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("BAD_REQUEST");
  });

  test("mobile renders with a phone viewport", async () => {
    const desktop = await scrape(browser, { url: `${widthPage.url}/`, formats: ["markdown"] });
    const mobile = await scrape(browser, { url: `${widthPage.url}/`, formats: ["markdown"], mobile: true });
    expect(desktop.body.data.markdown).toContain("innerWidth=1280");
    expect(mobile.body.data.markdown).toContain("innerWidth=390");
  });

  test("a PDF is fetched over plain HTTP even with a browser", async () => {
    const files = own(staticSite());
    const r = await scrape(browser, { url: `${files.url}/scan.pdf`, formats: ["markdown"] });
    expect(r.status).toBe(200);
    expect(r.body.data.metadata.contentType).toBe("application/pdf");
    expect(r.body.data.metadata.numPages).toBe(1);
  });

  test("the browser refuses private addresses unless allowed", async () => {
    const strict = await startSex(["--lightpanda"], { privateNetwork: false });
    const r = await scrape(strict, { url: `${jsPage.url}/`, formats: ["markdown"] });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("PRIVATE_NETWORK_BLOCKED");
    await strict.stop();
  });
});

describe("actions", () => {
  test("click, write, press, scroll, wait and executeJavascript (with return values) and scrape", async () => {
    const r = await scrape(browser, {
      url: `${formPage.url}/`,
      formats: ["markdown", "rawHtml"],
      actions: [
        { type: "click", selector: "#b" },
        { type: "scrape" },
        { type: "click", selector: "#i" },
        { type: "write", text: "hello" },
        { type: "press", key: "Enter" },
        { type: "scroll", direction: "down" },
        { type: "wait", milliseconds: 100 },
        { type: "wait", selector: "#w" },
        { type: "executeJavascript", script: "document.getElementById('i').value" },
        { type: "executeJavascript", script: "document.title" },
        { type: "executeJavascript", script: "({ a: 1, b: [2, 3] })" },
        { type: "executeJavascript", script: "document.getElementById('b').textContent" },
      ],
    });
    expect(r.status).toBe(200);
    const { actions, markdown, rawHtml } = r.body.data;
    expect(actions.javascriptReturns.map((j: any) => j.value)).toEqual(["hello", "entered hello", { a: 1, b: [2, 3] }, "clicked"]);
    expect(actions.javascriptReturns[2].type).toBe("object");
    expect(actions.scrapes).toHaveLength(1);
    expect(actions.scrapes[0].url).toBe(`${formPage.url}/`);
    // The scrape action is a snapshot in the middle of the sequence: after the click, before the typing.
    expect(actions.scrapes[0].html).toContain("clicked");
    expect(actions.scrapes[0].html).not.toContain("entered hello");
    expect(actions.screenshots).toEqual([]);
    // The page itself is read after the last action.
    expect(markdown).toContain("scrolled");
    expect(rawHtml).toContain("clicked");
  });

  test("an action that fails is ACTION_FAILED with its index", async () => {
    const missing = await scrape(browser, { url: `${formPage.url}/`, actions: [{ type: "click", selector: "#does-not-exist" }] });
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe("ACTION_FAILED");
    expect(missing.body.error).toContain("Action #0 (click)");
    const thrown = await scrape(browser, {
      url: `${formPage.url}/`,
      actions: [
        { type: "wait", milliseconds: 10 },
        { type: "executeJavascript", script: "throw new Error('boom')" },
      ],
    });
    expect(thrown.status).toBe(400);
    expect(thrown.body.code).toBe("ACTION_FAILED");
    expect(thrown.body.error).toContain("Action #1 (executeJavascript)");
    expect(thrown.body.error).toContain("boom");
  });

  test("a wait action needs exactly one of milliseconds and selector", async () => {
    for (const wait of [{ type: "wait" }, { type: "wait", milliseconds: 5, selector: "#w" }]) {
      const r = await scrape(browser, { url: `${formPage.url}/`, actions: [wait] });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe("BAD_REQUEST");
    }
  });

  test("screenshots and the pdf action are 501 even with a browser", async () => {
    const format = await scrape(browser, { url: `${formPage.url}/`, formats: ["screenshot"] });
    expect(format.status).toBe(501);
    expect(format.body.code).toBe("NOT_SUPPORTED");
    const shot = await scrape(browser, { url: `${formPage.url}/`, actions: [{ type: "screenshot" }] });
    expect(shot.status).toBe(501);
    expect(shot.body.code).toBe("NOT_SUPPORTED");
    const pdf = await scrape(browser, { url: `${formPage.url}/`, actions: [{ type: "pdf" }] });
    expect(pdf.status).toBe(501);
    expect(pdf.body.code).toBe("NOT_SUPPORTED");
  });

  test("actions without a browser are BROWSER_NOT_CONFIGURED; with fastMode a 400", async () => {
    const r = await scrape(plain, { url: `${formPage.url}/`, actions: [{ type: "wait", milliseconds: 10 }] });
    expect(r.status).toBe(501);
    expect(r.body.code).toBe("BROWSER_NOT_CONFIGURED");
    const fast = await scrape(browser, { url: `${formPage.url}/`, fastMode: true, actions: [{ type: "wait", milliseconds: 10 }] });
    expect(fast.status).toBe(400);
  });
});

describe("headers and credentials", () => {
  test("Authorization and Cookie go to the target origin only, other headers to every request", async () => {
    const seen: Array<{ origin: string; path: string; auth: string | null; cookie: string | null; custom: string | null }> = [];
    const record = (origin: string) => (req: Request, url: URL) => {
      seen.push({
        origin,
        path: url.pathname,
        auth: req.headers.get("authorization"),
        cookie: req.headers.get("cookie"),
        custom: req.headers.get("x-custom"),
      });
      if (url.pathname.endsWith(".js"))
        return new Response("window.loaded = (window.loaded || 0) + 1", { headers: { "content-type": "text/javascript" } });
      return html("Creds", prose("credentials"));
    };
    const other = own(site(record("other")));
    const target = own(
      site((req, url) => {
        if (url.pathname === "/") {
          seen.push({
            origin: "target",
            path: "/",
            auth: req.headers.get("authorization"),
            cookie: req.headers.get("cookie"),
            custom: req.headers.get("x-custom"),
          });
          // The third party is the same machine under another name (so another origin and another cookie host).
          const third = other.url.replace("127.0.0.1", "localhost");
          return html("Creds", `${prose("credentials")}<script src="/own.js"></script><script src="${third}/third.js"></script>`);
        }
        return record("target")(req, url);
      }),
    );
    const r = await scrape(browser, {
      url: `${target.url}/`,
      formats: ["markdown"],
      headers: { Authorization: "Bearer secret-token", Cookie: "session=abc; theme=dark", "X-Custom": "everywhere" },
    });
    expect(r.status).toBe(200);
    const main = seen.find((s) => s.origin === "target" && s.path === "/");
    expect(main?.auth).toBe("Bearer secret-token");
    expect(main?.cookie).toContain("session=abc");
    expect(main?.custom).toBe("everywhere");
    const own1 = seen.find((s) => s.origin === "target" && s.path === "/own.js");
    expect(own1?.auth).toBe("Bearer secret-token");
    const third = seen.find((s) => s.origin === "other" && s.path === "/third.js");
    expect(third).toBeDefined();
    expect(third?.auth).toBeNull();
    expect(third?.cookie).toBeNull();
  });
});

describe("blockAds", () => {
  test("is accepted either way and the page's own content is unaffected", async () => {
    const page = own(
      site(() =>
        html("Ads", `${prose("advertising")}<script src="http://ads.doubleclick.net/ad.js"></script><script src="/own.js"></script>`),
      ),
    );
    for (const blockAds of [true, false, undefined]) {
      const r = await scrape(browser, { url: `${page.url}/`, formats: ["markdown"], ...(blockAds === undefined ? {} : { blockAds }) });
      expect(r.status).toBe(200);
      expect(r.body.data.markdown).toContain("Paragraph 1 about advertising");
    }
  });
});

describe("fallback to plain HTTP", () => {
  test("a browser page that renders to nothing is answered over HTTP, with a warning", async () => {
    const r = await scrape(browser, { url: `${jsPage.url}/blank`, formats: ["markdown"] });
    expect(r.status).toBe(200);
    expect(r.body.data.markdown).toContain("Paragraph 1 about blanked");
    expect(r.body.data.warning).toContain("Browser returned no content; fell back to HTTP fetch");
  });

  // BUG: an unreachable CDP browser surfaces as 500 INTERNAL_ERROR "[object ErrorEvent]". README: a failed browser
  // scrape is answered over plain HTTP with a warning (BROWSER_UNAVAILABLE is a 502 that allows the fallback).
  test.failing("a browser that cannot be reached falls back to HTTP with a warning", async () => {
    const dead = await startSex(["--cdp-url", "ws://127.0.0.1:9"]);
    try {
      const r = await scrape(dead, { url: `${jsPage.url}/`, formats: ["markdown"] });
      expect(r.status).toBe(200);
      expect(r.body.data.markdown).toContain("server text");
      expect(r.body.data.warning).toBeTruthy();
    } finally {
      await dead.stop();
    }
  });
});
