import { afterAll, expect, test } from "bun:test";
import { bin } from "./bin.ts";
import { api, killAll, run, serve } from "./proc.ts";
import { staticSite } from "./sites.ts";
import { removeTempDirs } from "./tmp.ts";

const fixtures = staticSite();
afterAll(async () => {
  fixtures.stop();
  await killAll();
  removeTempDirs();
});

test("the harness runs a CLI fetch and a server", async () => {
  const r = await run(bin("sex-lite"), ["fetch", `${fixtures.url}/`, "--allow-private-network", "-f", "links"]);
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("report.docx");
  const s = await serve(bin("sex-lite"), ["--allow-private-network"]);
  expect((await api(s.url, "/health")).status).toBe(200);
  const res = await api(s.url, "/v2/scrape", { body: { url: `${fixtures.url}/`, formats: ["links"] } });
  expect(res.status).toBe(200);
  expect(await s.stop()).toBe(0);
});
