import { describe, expect, it } from "vitest";
import { MemoryStore } from "@bayanihan/core";
import { createApp } from "../src/app.js";
import { memoryFiles } from "../src/files.js";

const app = createApp({ store: new MemoryStore(), files: memoryFiles(), async identify(req) { return { person: req.headers.get("x-bix-person") }; }, now: () => "2026-11-04T10:00:00+08:00", newId: () => crypto.randomUUID() });
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const up = (who: string | null, type: string, body: Uint8Array<ArrayBuffer>, q = "") =>
  app.request(`/$files${q}`, { method: "POST", headers: { "content-type": type, ...(who ? { "x-bix-person": who } : {}) }, body });

describe("files", () => {
  it("keeps an uploaded photo and returns a BIX Attachment with its hash", async () => {
    const r = await up("Person/mia", "image/png", png, "?title=Attendance&showsMinors=true");
    expect(r.status).toBe(201);
    const a = await r.json();
    expect(a).toMatchObject({ contentType: "image/png", size: 7, title: "Attendance", showsMinors: true });
    expect(a.hash).toMatch(/^[a-f0-9]{64}$/);
    const back = await app.request(a.url, { headers: { "x-bix-person": "Person/mia" } });
    expect(new Uint8Array(await back.arrayBuffer())).toEqual(png);
  });
  it("doesn't let another signed-in person download a file that isn't on a record they can see", async () => {
    const a = await (await up("Person/mia", "image/png", new Uint8Array([9, 9, 9]))).json();
    expect((await app.request(a.url, { headers: { "x-bix-person": "Person/stranger" } })).status).toBe(404);
  });
  it("refuses anonymous uploads, unknown types and anonymous downloads", async () => {
    expect((await up(null, "image/png", png)).status).toBe(401);
    expect((await up("Person/mia", "application/x-msdownload", png)).status).toBe(415);
    const a = await (await up("Person/mia", "image/png", png)).json();
    expect((await app.request(a.url)).status).toBe(404);
  });
});
