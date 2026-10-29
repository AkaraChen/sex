import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readSync,
  rmSync,
  statSync,
  truncateSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openS3, S3DocumentLog, type S3Options } from "@searxng-js/sex-documents-s3";

/** Where one stored document's bytes are. */
export interface DocumentRef {
  object: string;
  offset: number;
  /** Byte length of the document's JSON text, which may end in whitespace (the JSONL newline). */
  length: number;
}

/**
 * Where scraped documents (Firecrawl Document JSON) are kept. The job store indexes them in SQLite (`documents`
 * table): it records the DocumentRef of each one and pages through them by that index, so a log only stores and
 * reads bytes. Implementations: one append-only JSONL file per job (default), one S3 object per document, or memory.
 */
export interface DocumentLog {
  /** Stores one document; resolves once the bytes are durable in the backend. */
  append(jobId: string, json: string): Promise<DocumentRef>;
  /** Reads `length` bytes at `offset` of `object`; returns fewer (or none) when the object is shorter or missing. */
  read(object: string, offset: number, length: number): Promise<Uint8Array>;
  /** Removes every object of the job, and nothing else. */
  drop(jobId: string): Promise<void>;
  /**
   * Only for logs that append a job's documents to one object in place: cuts the job's object back to `end` bytes if
   * it is longer (bytes written before a crash but never indexed) and returns its size afterwards, so index rows past
   * it can be dropped. The store calls it on open, before any append.
   */
  truncate?(jobId: string, end: number): Promise<number>;
}

/** Reads `length` bytes at `position` into `buf`; returns how many it got (fewer only at EOF). */
function readFully(fd: number, buf: Uint8Array, length: number, position: number): number {
  let done = 0;
  while (done < length) {
    const n = readSync(fd, buf, done, length - done, position + done);
    if (n === 0) break;
    done += n;
  }
  return done;
}

const JSONL = ".jsonl";

/**
 * One append-only `<jobId>.jsonl` file per job in `dir`, one document per line. The file I/O is synchronous: writing a
 * ~200 KB line to the page cache takes ~50 µs, and a synchronous append cannot interleave with another append to the
 * same file. Nothing is fsynced (like SQLite's `synchronous = NORMAL`): a crash of the process loses nothing that was
 * appended, an OS crash may lose the tail of a file, which `truncate` and the store's read checks then account for.
 */
export class FsDocumentLog implements DocumentLog {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  /** Job ids are UUIDs from the job store, never user input. */
  private path(object: string) {
    return join(this.dir, object);
  }

  async append(jobId: string, json: string): Promise<DocumentRef> {
    const object = `${jobId}${JSONL}`;
    const line = Buffer.from(`${json}\n`);
    const fd = openSync(this.path(object), constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND);
    const offset = fstatSync(fd).size;
    try {
      for (let done = 0; done < line.length; ) done += writeSync(fd, line, done, line.length - done);
    } catch (err) {
      try {
        ftruncateSync(fd, offset);
      } catch {
        // Unindexed bytes are cut off on the next open.
      }
      throw err;
    } finally {
      closeSync(fd);
    }
    return { object, offset, length: line.length };
  }

  async read(object: string, offset: number, length: number): Promise<Uint8Array> {
    const buf = Buffer.allocUnsafe(length);
    let fd: number;
    try {
      fd = openSync(this.path(object), "r");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return new Uint8Array(0);
      throw err;
    }
    try {
      return buf.subarray(0, readFully(fd, buf, length, offset));
    } finally {
      closeSync(fd);
    }
  }

  async drop(jobId: string) {
    rmSync(this.path(`${jobId}${JSONL}`), { force: true });
  }

  async truncate(jobId: string, end: number) {
    const path = this.path(`${jobId}${JSONL}`);
    const size = statSync(path, { throwIfNoEntry: false })?.size ?? 0;
    if (size <= end) return size;
    truncateSync(path, end);
    return end;
  }
}

/** Documents in a Map, for runs without a data dir (tests, one-shot CLI commands). */
export class MemoryDocumentLog implements DocumentLog {
  private readonly byJob = new Map<string, Map<string, Uint8Array>>();
  private next = 0;

  async append(jobId: string, json: string): Promise<DocumentRef> {
    const bytes = Buffer.from(json);
    const object = `${jobId}/${this.next++}`;
    const docs = this.byJob.get(jobId) ?? new Map<string, Uint8Array>();
    this.byJob.set(jobId, docs.set(object, bytes));
    return { object, offset: 0, length: bytes.length };
  }

  async read(object: string, offset: number, length: number) {
    const bytes = this.byJob.get(object.slice(0, object.indexOf("/")))?.get(object);
    return bytes ? bytes.subarray(offset, offset + length) : new Uint8Array(0);
  }

  async drop(jobId: string) {
    this.byJob.delete(jobId);
  }
}

/** Reads made in parallel for one page of documents (in practice only on S3, where each document is a read). */
export const READ_CONCURRENCY = 8;

/** Where documents are kept. */
export interface DocumentsOptions {
  /** `s3://bucket/prefix` or `file:///path`; takes precedence over `dataDir`. */
  documentsUrl?: string;
  /** JSONL files go to `<dataDir>/documents`; without either documents stay in memory. */
  dataDir?: string;
}

/** Where documents are kept, for `/health`: a file:// or s3:// URL, or "memory". */
export function documentsLocation(options: DocumentsOptions): string {
  if (options.documentsUrl) return options.documentsUrl;
  return options.dataDir ? pathToFileURL(join(options.dataDir, "documents")).href : "memory";
}

/**
 * The document log for the options: `documentsUrl` (s3://bucket/prefix or file:///path), else JSONL files under
 * `<dataDir>/documents`, else memory. The S3 client (`Bun.S3Client`, or the AWS SDK when there is no Bun) takes its endpoint
 * and credentials from the environment the way that client does; pass them in `s3` to set them here.
 */
export function createDocumentLog(options: DocumentsOptions & { s3?: Omit<S3Options, "bucket"> }): DocumentLog {
  if (options.documentsUrl) {
    const url = new URL(options.documentsUrl);
    if (url.protocol === "s3:") {
      const bucket = decodeURIComponent(url.hostname);
      return new S3DocumentLog(openS3({ ...options.s3, bucket }), decodeURIComponent(url.pathname));
    }
    return new FsDocumentLog(fileURLToPath(url));
  }
  if (options.dataDir) return new FsDocumentLog(join(options.dataDir, "documents"));
  return new MemoryDocumentLog();
}
