import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { openS3, S3DocumentLog, type S3Objects } from "@searxng-js/sex-documents-s3";

/** An S3 bucket in a Map. */
function fakeBucket() {
  const objects = new Map<string, Uint8Array>();
  const s3: S3Objects = {
    async put(key, bytes) {
      objects.set(key, bytes);
    },
    async read(key, offset, length) {
      return objects.get(key)?.subarray(offset, offset + length) ?? new Uint8Array(0);
    },
    async delete(key) {
      objects.delete(key);
    },
    async list(prefix) {
      return [...objects.keys()].filter((k) => k.startsWith(prefix));
    },
  };
  return { objects, s3 };
}

describe("S3DocumentLog", () => {
  test("one object per document under <prefix>/<jobId>/, read back by ref", async () => {
    const { objects, s3 } = fakeBucket();
    const log = new S3DocumentLog(s3, "/some/prefix/");
    const a = await log.append("job1", '{"a":1}');
    const b = await log.append("job1", '{"b":"é"}');
    assert.deepEqual(
      [...objects.keys()].map((k) => k.startsWith("some/prefix/job1/") && k.endsWith(".json")),
      [true, true],
    );
    assert.notEqual(a.object, b.object);
    assert.equal(a.offset, 0);
    assert.equal(b.length, new TextEncoder().encode('{"b":"é"}').length);
    assert.equal(new TextDecoder().decode(await log.read(b.object, b.offset, b.length)), '{"b":"é"}');
    assert.equal((await log.read("job1/missing.json", 0, 10)).length, 0);
  });

  test("drop removes the job's objects and nothing else", async () => {
    const { objects, s3 } = fakeBucket();
    const log = new S3DocumentLog(Promise.resolve(s3), "p");
    await log.append("job1", "{}");
    await log.append("job1", "{}");
    await log.append("job2", "{}");
    objects.set("p/job10/x.json", new Uint8Array(1));
    await log.drop("job1");
    assert.deepEqual([...objects.keys()].map((k) => k.split("/")[1]).sort(), ["job10", "job2"]);
  });

  test("a client that cannot open fails the first operation, not the constructor", async () => {
    const log = new S3DocumentLog(Promise.reject(new Error("no client")), "");
    await assert.rejects(log.append("job", "{}"), /no client/);
  });
});

describe("openS3 without Bun", () => {
  test("names the package to install when the AWS SDK is missing", async (t) => {
    if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") return t.skip("Bun has its own client");
    try {
      await import("@aws-sdk/client-s3");
      return t.skip("@aws-sdk/client-s3 is installed");
    } catch {
      await assert.rejects(openS3({ bucket: "b" }), /npm install @aws-sdk\/client-s3/);
    }
  });
});

// Against a real S3 server when SEX_TEST_S3_URL (s3://bucket/prefix) is set, with S3_ENDPOINT / S3_ACCESS_KEY_ID /
// S3_SECRET_ACCESS_KEY / S3_REGION: on Bun through Bun.S3Client, on Node through the AWS SDK.
describe("a real bucket", () => {
  const url = process.env.SEX_TEST_S3_URL;
  test("round trip, partial read, missing object, drop", { skip: !url }, async () => {
    const target = new URL(url as string);
    const env = process.env;
    const log = new S3DocumentLog(
      openS3({
        bucket: decodeURIComponent(target.hostname),
        endpoint: env.S3_ENDPOINT,
        region: env.S3_REGION,
        accessKeyId: env.S3_ACCESS_KEY_ID,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      }),
      `${decodeURIComponent(target.pathname)}/documents-s3-${crypto.randomUUID()}`,
    );
    const job = crypto.randomUUID();
    const ref = await log.append(job, '{"a":1,"e":"é"}');
    assert.equal(new TextDecoder().decode(await log.read(ref.object, 0, ref.length)), '{"a":1,"e":"é"}');
    assert.equal(new TextDecoder().decode(await log.read(ref.object, 1, 5)), '"a":1');
    assert.equal((await log.read(`${job}/none.json`, 0, 10)).length, 0);
    assert.equal((await log.read(ref.object, 100, 10)).length, 0);
    await log.drop(job);
    assert.equal((await log.read(ref.object, 0, 5)).length, 0);
  });
});
