import { describe, expect, it } from "vitest";
import { MemoryStore, type BixResource } from "@bayanihan/core";
import { createApp } from "../src/app.js";
import { frontPage } from "../src/front-page.js";

const org = (id: string, name: string, vis: string): BixResource => ({ resourceType: "Organization", id, meta: { version: 1 }, name,
  extension: [{ url: "bayanihan:visibility", value: vis }] });

describe("front page", () => {
  it("is branded HTML, and a hub doesn't call itself the Ecosystem", async () => {
    const app = createApp({ store: new MemoryStore(), async identify() { return { person: null }; }, now: () => "2026-11-01T09:00:00+08:00", newId: () => "x" });
    const res = await app.request("/");
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Bayanihan Server");
    expect(html).not.toContain("Dasig Ecosystem");
    expect(html).toContain('href="/metadata"');
  });

  it("names the Ecosystem, and hides small counts", () => {
    const few = frontPage({ ecosystem: true, groups: 2, projects: 0 });
    expect(few).toContain("Dasig Ecosystem");
    expect(few).toContain("in pilot");
    expect(few).toContain("A few");
    expect(few).toContain("None yet");
    expect(few).not.toMatch(/<b>2<\/b>/);
    expect(frontPage({ ecosystem: true, groups: 12, projects: 7 })).toContain("<b>12</b>");
  });

  it("never counts or names a private group", async () => {
    const store = new MemoryStore();
    store.put(org("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "Hidden Committee", "invited"));
    const app = createApp({ store, async identify() { return { person: null }; }, now: () => "2026-11-01T09:00:00+08:00", newId: () => "x",
      openJoin: { audience: "http://localhost" } });
    const html = await (await app.request("/")).text();
    expect(html).not.toContain("Hidden Committee");
    expect(html).toContain("None yet");
  });
});
