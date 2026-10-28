import * as validators from "@bayanihan/bix/validators";

export const BIX_BASE = "https://bix.bayanihan.dev/v0.1/";
export type BixResource = { resourceType: string; id: string; meta: { version: number; [k: string]: unknown }; [k: string]: unknown };
export type ValidationError = { path: string; message: string };
export type ValidationResult = { valid: boolean; errors: ValidationError[] };
type Validator = ((d: unknown) => boolean) & { errors?: { instancePath?: string; message?: string }[] | null };
const table = validators as unknown as Record<string, Validator>;

/** Resource types BIX v0.1 defines. Validators are compiled ahead of time (bix/tools/build_validators.mjs). */
export const resourceTypes: string[] = Object.keys(table).filter((k) => typeof table[k] === "function");

/** Check a record against its BIX schema. Unknown types are refused, never guessed. */
export function validate(resource: unknown): ValidationResult {
  const type = (resource as { resourceType?: unknown })?.resourceType;
  if (typeof type !== "string" || !resourceTypes.includes(type)) {
    return { valid: false, errors: [{ path: "/resourceType", message: `unknown resource type: ${String(type)}` }] };
  }
  const check = table[type]!;
  const valid = check(resource);
  return { valid, errors: (check.errors ?? []).map((e) => ({ path: e.instancePath || "/", message: e.message ?? "invalid" })) };
}
