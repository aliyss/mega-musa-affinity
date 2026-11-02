import assert from "node:assert/strict";
import test from "node:test";

import { expandPromptTemplate, PromptExpansionError } from "../lib/prompt-expansion.mjs";
import { MAX_BRACKET_GENERATION_JOBS } from "../lib/limits.mjs";

test("expands combined brace groups", () => {
  assert.deepEqual(expandPromptTemplate("a {red, blue} {balloon, car}"), [
    "a red balloon",
    "a red car",
    "a blue balloon",
    "a blue car",
  ]);
});

test("supports multipliers inside alternatives", () => {
  assert.deepEqual(expandPromptTemplate("{a photo of a {banana, strawberry}, 2}"), [
    "a photo of a banana",
    "a photo of a banana",
    "a photo of a strawberry",
    "a photo of a strawberry",
  ]);
});

test("supports escape sequences for literal characters", () => {
  assert.deepEqual(expandPromptTemplate("a \\{red\\}, \\, literal"), ["a {red}, , literal"]);
});

test("keeps a plain prompt as one entry", () => {
  assert.deepEqual(expandPromptTemplate("a quiet harbour at dawn"), ["a quiet harbour at dawn"]);
});

test("rejects unbalanced braces", () => {
  assert.throws(() => expandPromptTemplate("a {red, blue"), PromptExpansionError);
  assert.throws(() => expandPromptTemplate("a red}"), PromptExpansionError);
});

test("rejects empty alternatives and bad multipliers", () => {
  assert.throws(() => expandPromptTemplate("a {red, }"), PromptExpansionError);
  assert.throws(() => expandPromptTemplate("a {red, blue, 0}"), PromptExpansionError);
  assert.throws(() => expandPromptTemplate("a {red, blue, 1.5}"), PromptExpansionError);
});

test("stops at the bracket generation limit", () => {
  const prompt = Array.from({ length: 12 }, () => "{a, b}").join(" ");
  assert.throws(() => expandPromptTemplate(prompt, MAX_BRACKET_GENERATION_JOBS), PromptExpansionError);
  assert.equal(expandPromptTemplate("{a, b} {c, d}", 4).length, 4);
});
