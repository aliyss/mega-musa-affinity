/*
 * Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Affinity edition: see LICENSE-EXCEPTION.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createServer } from "../lib/server.mjs";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

async function start({ placeInAffinity } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mega-musa-place-"));
  const instance = createServer({
    dataDir,
    handoffDir: path.join(dataDir, "handoff"),
    services: placeInAffinity ? { placeInAffinity } : {},
  });
  const { port } = await instance.listen(0);
  return { instance, dataDir, base: `http://127.0.0.1:${port}` };
}

async function post(base, route, body = {}) {
  const response = await fetch(`${base}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

test("placing the newest result hands its path to Affinity's bridge", async () => {
  const calls = [];
  const harness = await start({
    placeInAffinity: async ({ file }) => {
      calls.push(file);
      return { ok: true, message: "MEGA_MUSA_PLACED CMYKA8 layers 2->3" };
    },
  });
  try {
    fs.mkdirSync(path.join(harness.dataDir, "images"), { recursive: true });
    fs.writeFileSync(path.join(harness.dataDir, "images", "latest.png"), PNG);

    const result = await post(harness.base, "/api/place");
    assert.equal(result.status, 200);
    assert.equal(result.json.ok, true);
    assert.match(result.json.message, /MEGA_MUSA_PLACED/);
    assert.equal(calls.length, 1);
    assert.equal(path.basename(calls[0]), "latest.png");
    assert.ok(fs.existsSync(calls[0]));
  } finally {
    await harness.instance.close();
  }
});

test("placing with nothing generated explains what to do", async () => {
  const harness = await start({ placeInAffinity: async () => ({ ok: true, message: "unused" }) });
  try {
    const result = await post(harness.base, "/api/place");
    assert.equal(result.status, 404);
    assert.match(result.json.error, /Generate an image first/);
  } finally {
    await harness.instance.close();
  }
});

test("a rejected file is reported, not treated as success", async () => {
  const harness = await start({ placeInAffinity: async () => ({ ok: false, message: "Affinity is not listening." }) });
  try {
    fs.mkdirSync(path.join(harness.dataDir, "images"), { recursive: true });
    fs.writeFileSync(path.join(harness.dataDir, "images", "latest.png"), PNG);
    const result = await post(harness.base, "/api/place");
    assert.equal(result.status, 200);
    assert.deepEqual(result.json, { ok: false, message: "Affinity is not listening." });
  } finally {
    await harness.instance.close();
  }
});

test("autoPlace is stored and reported by the state", async () => {
  const harness = await start({ placeInAffinity: async () => ({ ok: true, message: "placed" }) });
  try {
    const before = await (await fetch(`${harness.base}/api/state`)).json();
    assert.equal(before.settings.autoPlace, false);

    const saved = await post(harness.base, "/api/settings", { autoPlace: true });
    assert.equal(saved.json.settings.autoPlace, true);

    const after = await (await fetch(`${harness.base}/api/state`)).json();
    assert.equal(after.settings.autoPlace, true);
  } finally {
    await harness.instance.close();
  }
});
