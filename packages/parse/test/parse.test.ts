import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Parser, ParserError, ParserTimeoutError, ParserUnavailableError } from "../src/index.ts";

let dir: string;
let ok: string;
let bad: string;
let slow: string;

const script = (body: string) => `#!/usr/bin/env bun\n${body}\n`;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "sex-parse-test-"));
  const write = async (name: string, body: string) => {
    const path = join(dir, name);
    await writeFile(path, script(body));
    await chmod(path, 0o755);
    return path;
  };
  ok = await write(
    "ok",
    `const input = await Bun.stdin.text();
const at = process.argv.indexOf("--filename");
console.log(JSON.stringify({ markdown: "input=" + input + " name=" + process.argv[at + 1], warnings: [{ code: "x", message: "warned" }] }));`,
  );
  bad = await write("bad", `console.error("boom"); process.exit(3);`);
  slow = await write("slow", `await new Promise((resolve) => setTimeout(resolve, 5000));`);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("the bytes go in on stdin and the JSON answer comes back", async () => {
  const parsed = await new Parser({ path: ok }).parse({
    bytes: new TextEncoder().encode("hello"),
    filename: "report.docx",
  });
  expect(parsed.markdown).toBe("input=hello name=report.docx");
  expect(parsed.warnings).toEqual(["warned"]);
});

test("a non-zero exit is a ParserError with the child's stderr", async () => {
  const error = await new Parser({ path: bad })
    .parse({ bytes: new Uint8Array(), filename: "a.docx" })
    .catch((err) => err);
  expect(error).toBeInstanceOf(ParserError);
  expect(error.message).toContain("code 3");
  expect(error.message).toContain("boom");
});

test("a conversion that runs out of time is killed", async () => {
  const error = await new Parser({ path: slow, timeoutMs: 100 })
    .parse({ bytes: new Uint8Array(), filename: "scan.pdf" })
    .catch((err) => err);
  expect(error).toBeInstanceOf(ParserTimeoutError);
});

test("a missing binary is ParserUnavailableError", async () => {
  const error = await new Parser({ path: join(dir, "nope") })
    .parse({ bytes: new Uint8Array(), filename: "a.pdf" })
    .catch((err) => err);
  expect(error).toBeInstanceOf(ParserUnavailableError);
});

test("a JS path is run with bun", async () => {
  // `here-docs`' own dist/cli.js is not executable in some installs; the parser picks a runtime for it.
  const js = join(dir, "cli.js");
  await writeFile(js, `console.log(JSON.stringify({ markdown: "from js", warnings: [] }));`);
  const parsed = await new Parser({ path: js }).parse({ bytes: new Uint8Array(), filename: "a.pdf" });
  expect(parsed.markdown).toBe("from js");
});
