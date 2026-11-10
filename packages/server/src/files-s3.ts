import { sha256hex, type FileMeta, type FileStore } from "./files.js";

/** The few S3 calls this store needs, so tests can pass a fake and self-hosters can use any S3-compatible storage (e.g. MinIO). */
export type S3Like = {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
};
type Meta = { save(m: FileMeta): Promise<void>; load(hash: string): Promise<FileMeta | null> };

/**
 * Files in S3-compatible storage, addressed by their SHA-256, with their metadata in the server's database.
 * Files stored before the switch are still read from `previous` (e.g. the database), so nothing needs moving at once.
 */
export function s3Files(s3: S3Like, prefix: string, meta: Meta, previous?: FileStore): FileStore {
  const key = (hash: string) => `${prefix.replace(/\/?$/, "/")}${hash}`;
  return {
    async put(bytes, m) {
      const hash = await sha256hex(bytes);
      const have = await meta.load(hash);
      if (!have || !(await s3.get(key(hash)))) await s3.put(key(hash), bytes, m.contentType);
      const full = have ?? { ...m, hash, size: bytes.byteLength };
      if (!have) await meta.save(full);
      return full;
    },
    async get(hash) {
      const m = await meta.load(hash);
      if (!m) return null;
      const bytes = await s3.get(key(hash));
      if (bytes) return { bytes, meta: m };
      return previous ? previous.get(hash) : null;
    },
  };
}

/** An S3Like from the AWS SDK. Credentials come from the usual AWS environment variables or role. */
export async function awsS3(bucket: string, region: string, endpoint?: string): Promise<S3Like> {
  const { S3Client, PutObjectCommand, GetObjectCommand } = await import("@aws-sdk/client-s3");
  const c = new S3Client({ region, ...(endpoint ? { endpoint, forcePathStyle: true } : {}) });
  return {
    async put(Key, Body, ContentType) { await c.send(new PutObjectCommand({ Bucket: bucket, Key, Body, ContentType, ServerSideEncryption: "AES256" })); },
    async get(Key) {
      try { const r = await c.send(new GetObjectCommand({ Bucket: bucket, Key })); return r.Body ? new Uint8Array(await r.Body.transformToByteArray()) : null; }
      catch (e) { if ((e as { name?: string }).name === "NoSuchKey") return null; throw e; }
    },
  };
}
