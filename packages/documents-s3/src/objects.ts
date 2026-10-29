import { AppError } from "@searxng-js/sex-errors";

/** Where an S3 bucket is and how to reach it. Unset fields are the client's own defaults (the AWS_* variables on Node; S3_* / AWS_* on Bun). */
export interface S3Options {
  bucket: string;
  endpoint?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}

/** The few S3 operations a document log needs, so the log does not care which client does them. */
export interface S3Objects {
  /** Stores `bytes` under `key`; resolves once S3 has them. */
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  /** Bytes `[offset, offset + length)` of the object; fewer (or none) when it is shorter or does not exist. */
  read(key: string, offset: number, length: number): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
  /** Every key under `prefix`, across result pages. */
  list(prefix: string): Promise<string[]>;
}

const defined = <T extends object>(o: T): Partial<T> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

/** `Bun.S3Client` where there is one, else the AWS SDK (an optional peer dependency of the package that contains this code). */
export async function openS3(options: S3Options): Promise<S3Objects> {
  return typeof Bun !== "undefined" ? bunObjects(options) : awsObjects(options);
}

function bunObjects(options: S3Options): S3Objects {
  const client = new Bun.S3Client(defined(options) as ConstructorParameters<typeof Bun.S3Client>[0]);
  return {
    async put(key, bytes, contentType) {
      await client.write(key, bytes, { type: contentType });
    },
    async read(key, offset, length) {
      try {
        return await client
          .file(key)
          .slice(offset, offset + length)
          .bytes();
      } catch (err) {
        // A range past the end of a shorter object is "fewer bytes", as the interface says.
        const code = (err as { code?: string }).code;
        if (code === "NoSuchKey" || code === "InvalidRange") return new Uint8Array(0);
        throw err;
      }
    },
    async delete(key) {
      await client.delete(key);
    },
    async list(prefix) {
      const keys: string[] = [];
      let continuationToken: string | undefined;
      do {
        const page = await client.list({ prefix, continuationToken });
        for (const o of page.contents ?? []) keys.push(o.key);
        continuationToken = page.isTruncated ? page.nextContinuationToken : undefined;
      } while (continuationToken);
      return keys;
    },
  };
}

async function awsObjects(options: S3Options): Promise<S3Objects> {
  let sdk: typeof import("@aws-sdk/client-s3");
  try {
    sdk = await import("@aws-sdk/client-s3");
  } catch (cause) {
    throw new AppError(
      "NOT_SUPPORTED",
      "Storing documents on S3 outside Bun needs the optional peer dependency `@aws-sdk/client-s3`: run `npm install @aws-sdk/client-s3`.",
      { cause: cause instanceof Error ? cause.message : String(cause) },
    );
  }
  const { bucket, endpoint, region, accessKeyId, secretAccessKey } = options;
  const client = new sdk.S3Client({
    ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
    // The SDK insists on a region; custom endpoints (MinIO, SeaweedFS, R2) ignore it.
    region: region ?? (endpoint ? "us-east-1" : undefined),
    ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
  });
  const missing = (err: unknown) => {
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    return e.name === "NoSuchKey" || e.name === "InvalidRange" || e.$metadata?.httpStatusCode === 404;
  };
  return {
    async put(key, bytes, contentType) {
      await client.send(new sdk.PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, ContentType: contentType }));
    },
    async read(key, offset, length) {
      if (length <= 0) return new Uint8Array(0);
      try {
        const res = await client.send(
          new sdk.GetObjectCommand({ Bucket: bucket, Key: key, Range: `bytes=${offset}-${offset + length - 1}` }),
        );
        return (await res.Body?.transformToByteArray()) ?? new Uint8Array(0);
      } catch (err) {
        if (missing(err)) return new Uint8Array(0);
        throw err;
      }
    },
    async delete(key) {
      await client.send(new sdk.DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
    async list(prefix) {
      const keys: string[] = [];
      let continuationToken: string | undefined;
      do {
        const page = await client.send(
          new sdk.ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: continuationToken }),
        );
        for (const o of page.Contents ?? []) if (o.Key) keys.push(o.Key);
        continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (continuationToken);
      return keys;
    },
  };
}
