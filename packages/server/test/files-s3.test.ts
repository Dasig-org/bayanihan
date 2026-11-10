import { describe, expect, it } from "vitest";
import { memoryFiles } from "../src/files.js";
import { s3Files, type S3Like } from "../src/files-s3.js";

describe("files in S3-compatible storage", () => {
  it("stores by hash once, reads back, and still reads files kept before the switch", async () => {
    const objects = new Map<string, Uint8Array>(); let puts = 0;
    const s3: S3Like = { async put(k, b) { puts++; objects.set(k, b); }, async get(k) { return objects.get(k) ?? null; } };
    const metas = new Map<string, any>(); const meta = { async save(m: any) { metas.set(m.hash, m); }, async load(h: string) { return metas.get(h) ?? null; } };
    const old = memoryFiles(); const before = await old.put(new Uint8Array([9, 9, 9]), { contentType: "image/png", uploadedBy: "Person/a", showsMinors: false }); await meta.save(before);
    const f = s3Files(s3, "files/", meta, old);
    const a = await f.put(new Uint8Array([1, 2, 3]), { contentType: "image/jpeg", uploadedBy: "Person/a", showsMinors: false });
    await f.put(new Uint8Array([1, 2, 3]), { contentType: "image/jpeg", uploadedBy: "Person/b", showsMinors: false });
    expect(puts).toBe(1);
    expect([...(await f.get(a.hash))!.bytes]).toEqual([1, 2, 3]);
    expect([...objects.keys()][0]).toBe(`files/${a.hash}`);
    expect([...(await f.get(before.hash))!.bytes]).toEqual([9, 9, 9]);
  });
});
