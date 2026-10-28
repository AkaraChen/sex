/**
 * Schema splitting and deterministic merging of partial extraction results, after Firecrawl's
 * extract helpers (spread-schemas, deduplicate-objs-array, merge-null-val-objs). Merging in code
 * instead of asking the LLM keeps every item and costs nothing.
 */

type Schema = Record<string, unknown>;

/** Keywords a sub-schema must keep so `$ref`s and the dialect still resolve. */
const SHARED_KEYWORDS = ["$schema", "$defs", "definitions"];

function properties(schema: Schema): Record<string, Schema> {
  const p = schema.properties;
  return p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, Schema>) : {};
}

function hasType(schema: Schema | undefined, type: string): boolean {
  const t = schema?.type;
  return t === type || (Array.isArray(t) && t.includes(type));
}

/** Top-level keys whose value is (or contains) an array: candidates for multi-entity extraction. */
export function arrayKeys(schema: Schema): string[] {
  const contains = (s: Schema | undefined, depth: number): boolean =>
    !!s && (hasType(s, "array") || (depth < 3 && Object.values(properties(s)).some((p) => contains(p, depth + 1))));
  return Object.entries(properties(schema))
    .filter(([, s]) => contains(s, 0))
    .map(([k]) => k);
}

/**
 * Splits an object schema into the part holding `keys` and the rest. Dotted keys from the planner
 * ("shop.products") select their top-level key. Either part is undefined when it would be empty.
 */
export function splitSchema(schema: Schema, keys: string[]): { multi?: Schema; single?: Schema } {
  const props = properties(schema);
  const multiKeys = new Set(keys.map((k) => k.split(".")[0] ?? k).filter((k) => k in props));
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  const part = (pick: (k: string) => boolean): Schema | undefined => {
    const picked = Object.entries(props).filter(([k]) => pick(k));
    if (!picked.length) return undefined;
    const out: Schema = { type: "object", properties: Object.fromEntries(picked), required: required.filter(pick) };
    for (const kw of SHARED_KEYWORDS) if (kw in schema) out[kw] = schema[kw];
    return out;
  };
  return { multi: part((k) => multiKeys.has(k)), single: part((k) => !multiKeys.has(k)) };
}

/** Adds a required boolean property to an object schema. */
export function withProperty(schema: Schema, name: string, description: string): Schema {
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  return {
    ...schema,
    properties: { ...properties(schema), [name]: { type: "boolean", description } },
    required: [...required.filter((r) => r !== name), name],
  };
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Values the model uses for "not on the page". */
const isEmpty = (v: unknown) => v === null || v === undefined || v === "" || v === "null";

/** Drops exact duplicates, keeping first occurrences. */
export function dedupe(items: unknown[]): unknown[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = JSON.stringify(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Two objects describe the same entity when they agree on every scalar field both have, and share at least one. */
function sameEntity(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  let compared = 0;
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[key];
    const y = b[key];
    if (isEmpty(x) || isEmpty(y) || typeof x === "object" || typeof y === "object") continue;
    compared++;
    if (x !== y) return false;
  }
  return compared > 0;
}

/**
 * Merges array items that are the same entity seen on different pages (one page had the price,
 * another the description), filling empty fields from each other, then drops duplicates.
 */
export function mergeEntities(items: unknown[]): unknown[] {
  const merged: unknown[] = [];
  for (const item of items) {
    const i = isObject(item) ? merged.findIndex((m) => isObject(m) && sameEntity(m, item)) : -1;
    if (i === -1) merged.push(item);
    else merged[i] = mergeValues(merged[i], item);
  }
  return dedupe(merged);
}

/**
 * Deep merge of two partial results: arrays are concatenated and their entities merged, objects
 * merged key by key, and for scalars the first non-empty value wins (sources are in priority order).
 */
export function mergeValues(a: unknown, b: unknown): unknown {
  if (isEmpty(a)) return isEmpty(b) ? a : b;
  if (isEmpty(b)) return a;
  if (Array.isArray(a) && Array.isArray(b)) return mergeEntities([...a, ...b]);
  if (isObject(a) && isObject(b)) {
    const out: Record<string, unknown> = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = k in out ? mergeValues(out[k], v) : v;
    return out;
  }
  return a;
}

export function mergeAll(values: unknown[]): unknown {
  return values.reduce((acc, v) => mergeValues(acc, v), undefined);
}

/** Fields (dotted paths) where a later result disagrees with the value already kept; `mergeValues` keeps the first. Arrays are concatenated, so never conflict. */
export function conflictingFields(values: unknown[]): string[] {
  const found = new Set<string>();
  const walk = (kept: unknown, next: unknown, path: string) => {
    if (isEmpty(kept) || isEmpty(next) || Array.isArray(kept) || Array.isArray(next)) return;
    if (isObject(kept) && isObject(next)) {
      for (const [k, v] of Object.entries(next)) if (k in kept) walk(kept[k], v, path ? `${path}.${k}` : k);
    } else if (kept !== next) found.add(path || "(value)");
  };
  let acc: unknown;
  for (const value of values) {
    walk(acc, value, "");
    acc = mergeValues(acc, value);
  }
  return [...found];
}

const sameItem = (a: unknown, b: unknown) => (isObject(a) && isObject(b) && sameEntity(a, b)) || JSON.stringify(a) === JSON.stringify(b);

/**
 * Which pages each array item of a merged result came from, as Firecrawl's `{"products[0]": [url, ...]}`. A page's
 * item is traced to the merged item `mergeEntities` folded it into: the first one that is the same entity (a merged
 * item agrees with every item merged into it, so the lookup finds it again). Only the top-level arrays are covered;
 * a root array is keyed `[0]`, `[1]`, ...
 */
export function entitySources(merged: unknown, pieces: Array<{ url: string; value: unknown }>): Record<string, string[]> {
  const arrays: Array<[string, unknown[]]> = Array.isArray(merged)
    ? [["", merged]]
    : isObject(merged)
      ? Object.entries(merged).filter((e): e is [string, unknown[]] => Array.isArray(e[1]))
      : [];
  const out: Record<string, string[]> = {};
  for (const [key, items] of arrays) {
    for (const piece of pieces) {
      const own = Array.isArray(piece.value) ? piece.value : isObject(piece.value) ? piece.value[key] : undefined;
      if (!Array.isArray(own)) continue;
      for (const item of own) {
        const at = items.findIndex((m) => sameItem(m, item));
        if (at === -1) continue;
        const name = `${key}[${at}]`;
        const urls = out[name] ?? [];
        if (!urls.includes(piece.url)) urls.push(piece.url);
        out[name] = urls;
      }
    }
  }
  return out;
}
