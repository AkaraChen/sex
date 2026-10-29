import assert from "node:assert/strict";
import { channel } from "node:diagnostics_channel";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { CHANNELS, type DiagnosticMessage, diagnostics, subscribeAll } from "@searxng-js/sex-diagnostics";

const packages = join(import.meta.dirname, "..", "..");

describe("diagnostics", () => {
  test("a call publishes { level, msg, fields? } on the package's channel", () => {
    const seen: DiagnosticMessage[] = [];
    const onMessage = (m: unknown) => seen.push(m as DiagnosticMessage);
    channel("searxng-js:sex:scrape").subscribe(onMessage);
    try {
      const log = diagnostics("searxng-js:sex:scrape");
      log.debug("a");
      log.info("b", { k: 1 });
      log.warn("c", { k: "v" });
      log.error("d");
    } finally {
      channel("searxng-js:sex:scrape").unsubscribe(onMessage);
    }
    assert.deepEqual(seen, [
      { level: "debug", msg: "a" },
      { level: "info", msg: "b", fields: { k: 1 } },
      { level: "warn", msg: "c", fields: { k: "v" } },
      { level: "error", msg: "d" },
    ]);
    assert.equal("fields" in seen[0]!, false);
  });

  test("a message goes to its own channel only", () => {
    const seen: string[] = [];
    const onMessage = (m: unknown) => seen.push((m as DiagnosticMessage).msg);
    channel("searxng-js:sex:llm").subscribe(onMessage);
    try {
      diagnostics("searxng-js:sex:page").warn("not for llm");
      diagnostics("searxng-js:sex:llm").warn("for llm");
    } finally {
      channel("searxng-js:sex:llm").unsubscribe(onMessage);
    }
    assert.deepEqual(seen, ["for llm"]);
  });

  test("a call before and after a subscription reaches only the subscription", () => {
    // Other tests in a shared process (bun test) may have subscribers of their own, so only this one's view is checked.
    const ch = channel("searxng-js:sex:store");
    const log = diagnostics("searxng-js:sex:store");
    log.error("before");
    const seen: string[] = [];
    const onMessage = (m: unknown) => seen.push((m as DiagnosticMessage).msg);
    ch.subscribe(onMessage);
    log.error("somebody does");
    ch.unsubscribe(onMessage);
    log.error("nobody again");
    assert.deepEqual(seen, ["somebody does"]);
  });

  test("subscribeAll hears every channel and can stop", () => {
    const seen: string[] = [];
    const stop = subscribeAll((m, name) => seen.push(`${name} ${m.level} ${m.msg}`));
    for (const name of CHANNELS) diagnostics(name).info("hi");
    stop();
    diagnostics("searxng-js:sex:map").info("after");
    assert.deepEqual(
      seen,
      CHANNELS.map((name) => `${name} info hi`),
    );
  });
});

/** Channel names written in a package's source (outside this library). */
function channelsPublishedBy(dir: string): Set<string> {
  const found = new Set<string>();
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (/\.(ts|js)$/.test(entry.name)) for (const m of readFileSync(p, "utf8").matchAll(/searxng-js:sex:[a-z-]+/g)) found.add(m[0]);
    }
  };
  walk(join(dir, "src"));
  return found;
}

describe("the channel list", () => {
  const published = readdirSync(packages, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .filter((e) => {
      try {
        return JSON.parse(readFileSync(join(packages, e.name, "package.json"), "utf8")).private !== true;
      } catch {
        return false;
      }
    })
    .map((e) => e.name);

  test("a published package publishes only on a channel the list has, and only its own", () => {
    const listed = new Set<string>(CHANNELS);
    for (const name of published) {
      const found = channelsPublishedBy(join(packages, name));
      for (const c of found) {
        assert.ok(listed.has(c), `${name} publishes on ${c}, which is not in CHANNELS`);
        assert.equal(c, `searxng-js:sex:${name}`, `${name} publishes on another package's channel`);
      }
    }
  });

  test("every listed channel belongs to a published package", () => {
    for (const c of CHANNELS) assert.ok(published.includes(c.slice("searxng-js:sex:".length)), `${c} has no published package`);
  });
});
