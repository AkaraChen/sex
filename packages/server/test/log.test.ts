import { afterEach, expect, test } from "bun:test";
import { diagnostics } from "@searxng-js/sex-diagnostics";
import { setLogLevel } from "../src/log.ts";

const original = process.stderr.write.bind(process.stderr);
afterEach(() => {
  process.stderr.write = original;
  setLogLevel("info");
});

function capture(run: () => void): string[] {
  const lines: string[] = [];
  process.stderr.write = ((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    run();
  } finally {
    process.stderr.write = original;
  }
  return lines;
}

test("a message on a package channel is written to stderr in the app's format", () => {
  const lines = capture(() =>
    diagnostics("searxng-js:sex:scrape").warn("something odd", { url: "https://a.test/", n: 2, note: "has space" }),
  );
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z WARN something odd url=https:\/\/a\.test\/ n=2 note="has space"\n$/);
});

test("the log level cuts channel messages as it cuts the app's own", () => {
  const log = diagnostics("searxng-js:sex:llm");
  expect(capture(() => log.debug("quiet"))).toEqual([]);
  setLogLevel("debug");
  expect(capture(() => log.debug("loud"))).toHaveLength(1);
  setLogLevel("error");
  expect(capture(() => log.warn("cut"))).toEqual([]);
});
