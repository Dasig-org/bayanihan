import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import schemas from "@bayanihan/bix/schemas/all.json" with { type: "json" };

export const BIX_BASE = "https://bix.bayanihan.dev/v0.1/";
export type BixResource = { resourceType: string; id: string; meta: { version: number; [k: string]: unknown }; [k: string]: unknown };
export type ValidationError = { path: string; message: string };
export type ValidationResult = { valid: boolean; errors: ValidationError[] };

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
for (const s of schemas as object[]) ajv.addSchema(s);

/** Resource types BIX v0.1 defines (every schema except the shared data types). */
export const resourceTypes: string[] = (schemas as { $id: string }[])
  .map((s) => s.$id.replace(BIX_BASE, "").replace(".schema.json", ""))
  .filter((n) => n !== "datatypes");

/** Check a record against its BIX schema. Unknown types are refused, never guessed. */
export function validate(resource: unknown): ValidationResult {
  const type = (resource as { resourceType?: unknown })?.resourceType;
  if (typeof type !== "string" || !resourceTypes.includes(type)) {
    return { valid: false, errors: [{ path: "/resourceType", message: `unknown resource type: ${String(type)}` }] };
  }
  const check = ajv.getSchema(`${BIX_BASE}${type}.schema.json`)!;
  const valid = check(resource) as boolean;
  return {
    valid,
    errors: (check.errors ?? []).map((e) => ({ path: e.instancePath || "/", message: e.message ?? "invalid" })),
  };
}
