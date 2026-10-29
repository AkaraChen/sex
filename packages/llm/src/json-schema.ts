import { badRequest } from "@searxng-js/sex-errors";
import type { ErrorObject, Options, ValidateFunction } from "ajv";
import Ajv from "ajv";
import Ajv2019 from "ajv/dist/2019.js";
import Ajv2020 from "ajv/dist/2020.js";

const AJV_OPTIONS: Options = {
  // User schemas often carry vendor or documentation keywords; ignore them instead of rejecting the schema.
  strict: false,
  allErrors: true,
  // `format` is an annotation here: providers support only a few formats and we ship no format validators.
  validateFormats: false,
  logger: false,
};

const compiled = new WeakMap<object, ValidateFunction>();

/** Picks the Ajv dialect from `$schema`; schemas without one are treated as 2020-12 (what zod and pydantic emit). */
function ajvFor(schema: Record<string, unknown>) {
  const dialect = schema.$schema;
  if (dialect === undefined || (typeof dialect === "string" && dialect.includes("2020-12"))) return new Ajv2020(AJV_OPTIONS);
  if (typeof dialect === "string" && dialect.includes("2019-09")) return new Ajv2019(AJV_OPTIONS);
  if (typeof dialect === "string" && dialect.includes("draft-07")) return new Ajv(AJV_OPTIONS);
  throw badRequest(`Unsupported JSON Schema dialect ${JSON.stringify(dialect)}: use draft-07, 2019-09 or 2020-12`);
}

/**
 * Compiles a user-supplied JSON Schema, throwing 400 if it is invalid. Results are cached per schema
 * object; each schema gets its own Ajv instance so `$id`s cannot collide and nothing outlives the schema.
 */
export function compileJsonSchema(schema: Record<string, unknown>): ValidateFunction {
  let validate = compiled.get(schema);
  if (!validate) {
    const ajv = ajvFor(schema);
    try {
      validate = ajv.compile(schema);
    } catch (err) {
      throw badRequest(`Invalid JSON Schema: ${err instanceof Error ? err.message : String(err)}`);
    }
    compiled.set(schema, validate);
  }
  return validate;
}

/** One line per validation error, e.g. `/items/0/price must be number`. */
export function describeSchemaErrors(errors: ErrorObject[] | null | undefined, max = 10): string[] {
  const lines = (errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? "is invalid"}`);
  return lines.length > max ? [...lines.slice(0, max), `... and ${lines.length - max} more`] : lines;
}
