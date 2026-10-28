import canonicalize from "canonicalize";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import { sha256 as nobleSha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes, randomBytes } from "@noble/hashes/utils";
import type { BixResource } from "./validate.js";

// Pure JavaScript, so signing works the same in Node, browsers and the phone (Hermes has no WebCrypto).
ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

/** RFC 8785 canonical JSON of a record, without its signatures, so signing is stable. */
export function canonical(record: object): string {
  const { signature: _s, ...rest } = record as Record<string, unknown>;
  return canonicalize(rest) as string;
}

const enc = new TextEncoder();
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

export const sha256Hex = (bytes: Uint8Array) => bytesToHex(nobleSha256(bytes));
export async function sha256(record: object): Promise<string> { return sha256Hex(enc.encode(canonical(record))); }

/** A signing key: 32 random bytes as hex. The public key is derived from it. */
export type GroupKeyPair = { privateKey: string; publicKey: string };
export async function generateGroupKey(): Promise<GroupKeyPair> {
  const priv = randomBytes(32);
  return { privateKey: bytesToHex(priv), publicKey: bytesToHex(ed.getPublicKey(priv)) };
}

export type Signature = { who: { reference: string }; when: string; algorithm: "Ed25519"; keyId: string; value: string };

/** The group's server or hub signs a record (e.g. completed work) over its canonical form. */
export async function signRecord(record: BixResource, privateKeyHex: string, who: { reference: string }, keyId: string, when: string): Promise<Signature> {
  const sig = ed.sign(enc.encode(canonical(record)), hexToBytes(privateKeyHex));
  return { who, when, algorithm: "Ed25519", keyId, value: b64url(sig) };
}

/** Anyone can check a signed record against the group's public key. Any edit breaks it. */
export async function verifyRecord(record: BixResource, sig: Signature, publicKeyHex: string): Promise<boolean> {
  try { return ed.verify(unb64url(sig.value), enc.encode(canonical(record)), hexToBytes(publicKeyHex)); } catch { return false; }
}
