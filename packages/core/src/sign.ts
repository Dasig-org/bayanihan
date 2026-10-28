import canonicalize from "canonicalize";
import type { BixResource } from "./validate.js";

/** RFC 8785 canonical JSON of a record, without its signatures, so signing is stable. */
export function canonical(record: object): string {
  const { signature: _s, ...rest } = record as Record<string, unknown>;
  return canonicalize(rest) as string;
}

const enc = new TextEncoder();
const b64url = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

export async function sha256(record: object): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(canonical(record)));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export async function generateGroupKey(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
}

export type Signature = { who: { reference: string }; when: string; algorithm: "Ed25519"; keyId: string; value: string };

/** The group's server or hub signs a record (e.g. completed work) over its canonical form. */
export async function signRecord(record: BixResource, key: CryptoKey, who: { reference: string }, keyId: string, when: string): Promise<Signature> {
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, key, enc.encode(canonical(record)));
  return { who, when, algorithm: "Ed25519", keyId, value: b64url(sig) };
}

/** Anyone can check a signed record against the group's public key. Any edit breaks it. */
export async function verifyRecord(record: BixResource, sig: Signature, publicKey: CryptoKey): Promise<boolean> {
  return crypto.subtle.verify({ name: "Ed25519" }, publicKey, unb64url(sig.value), enc.encode(canonical(record)));
}
