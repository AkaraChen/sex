import pLimit from "p-limit";
import type { S3Objects } from "./objects.ts";

/** Parallel S3 requests per drop. */
const S3_CONCURRENCY = 8;

/** Where one stored document's bytes are (the same shape as sex-jobs' `DocumentRef`; the interface lives with its user). */
export interface S3DocumentRef {
  object: string;
  offset: number;
  length: number;
}

/**
 * One S3 object per document, `<prefix>/<jobId>/<random id>.json`. A PUT is durable once it resolves. Objects are immutable,
 * so there is nothing to truncate: a document written but never indexed is an orphan inside its job's prefix until the job is
 * dropped. Satisfies sex-jobs' `DocumentLog` structurally.
 */
export class S3DocumentLog {
  /** "" or "some/prefix/". */
  private readonly prefix: string;

  /** `objects` may still be opening (the AWS SDK is imported on demand): the first operation waits for it. */
  constructor(
    private readonly objects: S3Objects | Promise<S3Objects>,
    prefix: string,
  ) {
    const trimmed = prefix.replace(/^\/+|\/+$/g, "");
    this.prefix = trimmed ? `${trimmed}/` : "";
    // A client that cannot open is reported by the first operation, not as an unhandled rejection here.
    Promise.resolve(objects).catch(() => {});
  }

  async append(jobId: string, json: string): Promise<S3DocumentRef> {
    const object = `${jobId}/${crypto.randomUUID()}.json`;
    const bytes = new TextEncoder().encode(json);
    await (await this.objects).put(this.prefix + object, bytes, "application/json");
    return { object, offset: 0, length: bytes.length };
  }

  async read(object: string, offset: number, length: number): Promise<Uint8Array> {
    return (await this.objects).read(this.prefix + object, offset, length);
  }

  async drop(jobId: string): Promise<void> {
    const objects = await this.objects;
    const limit = pLimit(S3_CONCURRENCY);
    const keys = await objects.list(`${this.prefix}${jobId}/`);
    await Promise.all(keys.map((key) => limit(() => objects.delete(key))));
  }
}
