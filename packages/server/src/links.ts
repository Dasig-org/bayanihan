import { randomBytes } from "@noble/hashes/utils";
import { sha256hex } from "./files.js";

export interface LinkTokens { save(tokenHash: string, linkId: string): Promise<void>; find(tokenHash: string): Promise<string | null> }
export function memoryLinkTokens(): LinkTokens {
  const m = new Map<string, string>();
  return { async save(h, id) { m.set(h, id); }, async find(h) { return m.get(h) ?? null; } };
}
/** 128 bits, URL-safe. Unguessable; only its hash is stored. */
export function newToken(): string {
  const b = randomBytes(16);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export const hashToken = (t: string) => sha256hex(new TextEncoder().encode(t) as Uint8Array<ArrayBuffer>);
