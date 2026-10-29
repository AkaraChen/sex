import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { conflictingFields, entitySources, mergeAll, mergeEntities, splitSchema } from "@searxng-js/sex-jobs";

describe("conflictingFields", () => {
  test("pages that disagree on a single-answer field are named", () => {
    assert.deepEqual(
      conflictingFields([{ company: "Acme", ceo: { name: "A" } }, { company: "Acme Inc", ceo: { name: "A" }, hq: "Oslo" }, { hq: "Rome" }]),
      ["company", "hq"],
    );
    assert.deepEqual(conflictingFields([{ a: [1] }, { a: [2] }, { a: null }, { a: "x" }]), []);
  });
});

describe("entitySources", () => {
  test("traces each merged item to the pages it was seen on", () => {
    const pieces = [
      {
        url: "u1",
        value: {
          products: [
            { name: "X", price: null },
            { name: "Y", price: 2 },
          ],
        },
      },
      { url: "u2", value: { products: [{ name: "X", price: 5 }] } },
      {
        url: "u3",
        value: {
          products: [
            { name: "Y", price: 2 },
            { name: "Z", price: 1 },
          ],
        },
      },
    ];
    const merged = mergeAll(pieces.map((p) => p.value));
    assert.deepEqual(entitySources(merged, pieces), { "products[0]": ["u1", "u2"], "products[1]": ["u1", "u3"], "products[2]": ["u3"] });
  });

  test("root arrays are keyed [i]; items without scalars match by equality", () => {
    const pieces = [
      { url: "u1", value: [{ tags: ["a"] }] },
      { url: "u2", value: [{ tags: ["a"] }, { tags: ["b"] }] },
    ];
    assert.deepEqual(entitySources(mergeAll(pieces.map((p) => p.value)), pieces), { "[0]": ["u1", "u2"], "[1]": ["u2"] });
  });
});

describe("merge helpers", () => {
  test("entities agreeing on shared fields merge; conflicting ones stay apart", () => {
    assert.deepEqual(
      mergeEntities([
        { name: "A", price: null },
        { name: "A", price: 3 },
        { name: "A", price: 4 },
        { name: "A", price: 3 },
      ]),
      [
        { name: "A", price: 3 },
        { name: "A", price: 4 },
      ],
    );
  });

  test("scalars keep the first non-empty value; objects merge deeply", () => {
    assert.deepEqual(mergeAll([{ a: "", b: { c: 1 } }, { a: "x", b: { d: 2 } }, { a: "y" }]), { a: "x", b: { c: 1, d: 2 } });
  });

  test("splitSchema keeps $defs and required on both sides", () => {
    const { multi, single } = splitSchema(
      {
        $defs: { P: { type: "string" } },
        type: "object",
        properties: { a: { type: "array" }, b: { $ref: "#/$defs/P" } },
        required: ["a", "b"],
      },
      ["a.items"],
    );
    assert.deepEqual(multi?.properties, { a: { type: "array" } });
    assert.deepEqual(multi?.required, ["a"]);
    assert.deepEqual(multi?.$defs, { P: { type: "string" } });
    assert.deepEqual(single?.properties, { b: { $ref: "#/$defs/P" } });
    assert.deepEqual(single?.required, ["b"]);
    assert.deepEqual(single?.$defs, { P: { type: "string" } });
  });
});
