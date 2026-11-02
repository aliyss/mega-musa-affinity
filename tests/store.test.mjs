import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { addDescriptionToBudget, addToBudget, budgetCounts, formatDate } from "../lib/budget.mjs";
import { createStore } from "../lib/store.mjs";

function temporaryStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mega-musa-store-"));
  return { store: createStore(dir), dir };
}

test("settings persist and ignore unknown keys", () => {
  const { store, dir } = temporaryStore();
  store.saveSettings({ geminiApiKey: "gem-key", note: "ignored" });
  const saved = store.settings();
  assert.equal(saved.geminiApiKey, "gem-key");
  assert.equal("note" in saved, false);

  const reread = createStore(dir).settings();
  assert.equal(reread.geminiApiKey, "gem-key");
  assert.equal(reread.displayCurrency, "USD");
  assert.ok(fs.existsSync(path.join(dir, "settings.json")));
});

test("settings file is written with owner-only permissions", () => {
  const { store, dir } = temporaryStore();
  store.saveSettings({ openaiApiKey: "secret" });
  const mode = fs.statSync(path.join(dir, "settings.json")).mode & 0o777;
  assert.equal(mode, 0o600);
});

test("references are stored once per content hash", () => {
  const { store } = temporaryStore();
  const base64 = Buffer.from("reference-bytes").toString("base64");
  const first = store.writeReference(base64, "image/png");
  const second = store.writeReference(base64, "image/png");
  assert.equal(first.hash, second.hash);
  assert.equal(first.file, second.file);
  assert.ok(fs.existsSync(store.referencePath(first.file)));

  const other = store.writeReference(Buffer.from("other").toString("base64"), "image/png");
  assert.notEqual(other.hash, first.hash);
});

test("history keeps the newest entries first and caps the list", () => {
  const { store } = temporaryStore();
  for (let index = 0; index < 105; index += 1) {
    store.addHistory({ id: `entry-${index}`, prompt: `p${index}` });
  }
  const history = store.history();
  assert.equal(history.length, 100);
  assert.equal(history[0].id, "entry-104");
});

test("images are written under the images directory", () => {
  const { store } = temporaryStore();
  const file = store.writeImage(7, "image/png", Buffer.from([1, 2, 3]));
  assert.equal(file, "7.png");
  assert.deepEqual([...fs.readFileSync(store.imagePath(file))], [1, 2, 3]);
  assert.equal(path.basename(store.imagePath("../../etc/passwd")), "passwd");
});

test("budget counters separate priced, unpriced and canceled work", () => {
  const { store } = temporaryStore();
  addToBudget(store, 0.25);
  addToBudget(store, null);
  addToBudget(store, 0.5, true);
  addDescriptionToBudget(store, 0.02, 2);
  const budget = store.budget();
  assert.equal(budget.usd.toFixed(2), "0.77");
  assert.equal(budget.images, 1);
  assert.equal(budget.unpriced, 1);
  assert.equal(budget.cancelled, 1);
  assert.equal(budget.imagesAnalyzed, 2);
  assert.match(budgetCounts(budget), /1 images, 2 images described/);
});

test("reset clears totals but keeps a fresh date", () => {
  const { store } = temporaryStore();
  addToBudget(store, 1);
  const reset = store.resetBudget();
  assert.equal(reset.usd, 0);
  assert.equal(reset.images, 0);
  assert.ok(Date.parse(reset.since) > 0);
  assert.notEqual(formatDate(reset.since), "—");
});
