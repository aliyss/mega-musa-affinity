import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createServer } from "../lib/server.mjs";
import { makePng } from "./support.mjs";

const PNG = makePng(64, 48);

function waitForJobs(base, predicate, timeout = 5000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const { jobs } = await (await fetch(`${base}/api/jobs`)).json();
        if (predicate(jobs)) return resolve(jobs);
        if (Date.now() - started > timeout) return reject(new Error("Timed out waiting for jobs."));
      } catch (error) {
        return reject(error);
      }
      setTimeout(tick, 25);
    };
    tick();
  });
}

function fakeServices(overrides = {}) {
  return {
    generateImage: async (request) => {
      request.onDispatch?.();
      return { mimeType: "image/png", bytes: PNG, usage: { outputTokens: 10 }, costUSD: 0.05 };
    },
    describeImages: async ({ images }) => ({
      descriptions: images.map((_, index) => `COMPOSITION:\n- item ${index}`),
      usage: { inputTokens: 100, outputTokens: 50 },
    }),
    openFile: async () => ({ ok: true, app: "Affinity" }),
    revealFile: async () => ({ ok: true }),
    fetch: async () => ({ ok: true, json: async () => ({ rates: { EUR: 0.91 }, date: "2026-10-30" }) }),
    ...overrides,
  };
}

async function start(overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mega-musa-server-"));
  const handoffDir = path.join(dataDir, "handoff");
  const instance = createServer({ dataDir, handoffDir, services: fakeServices(overrides) });
  const { port } = await instance.listen(0);
  return { instance, base: `http://127.0.0.1:${port}`, dataDir, handoffDir };
}

test("panel and shared modules are served", async () => {
  const { instance, base } = await start();
  try {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Mega Musa/);

    const shared = await fetch(`${base}/lib/models.mjs`);
    assert.equal(shared.status, 200);
    assert.match(shared.headers.get("content-type"), /javascript/);
    assert.match(await shared.text(), /DEFAULT_MODEL/);

    for (const traversal of ["/lib/%2e%2e/settings.json", "/api/images/..%2Fsettings.json"]) {
      assert.equal((await fetch(`${base}${traversal}`)).status, 404);
    }
  } finally {
    await instance.close();
  }
});

test("state starts empty and keys are never echoed", async () => {
  const { instance, base } = await start();
  try {
    const initial = await (await fetch(`${base}/api/state`)).json();
    assert.equal(initial.settings.hasGeminiKey, false);
    assert.equal(initial.settings.displayCurrency, "USD");
    assert.deepEqual(initial.jobs, []);
    assert.equal(initial.defaults.model, "gemini-3-pro-image");

    const saved = await fetch(`${base}/api/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ geminiApiKey: "gem-secret-value", displayCurrency: "EUR" }),
    });
    const json = await saved.json();
    assert.equal(json.settings.hasGeminiKey, true);
    assert.equal(json.settings.displayCurrency, "EUR");
    assert.equal(JSON.stringify(json).includes("gem-secret-value"), false);
  } finally {
    await instance.close();
  }
});

test("generation expands prompts, bills, saves history and serves the image", async () => {
  const calls = [];
  const { instance, base, dataDir } = await start({
    generateImage: async (request) => {
      calls.push(request);
      request.onDispatch?.();
      return { mimeType: "image/png", bytes: PNG, usage: { outputTokens: 10 }, costUSD: 0.05 };
    },
  });
  try {
    await fetch(`${base}/api/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ geminiApiKey: "key" }),
    });

    const missingPrompt = await fetch(`${base}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "   " }),
    });
    assert.equal(missingPrompt.status, 400);

    const badModel = await fetch(`${base}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "a bird", model: "nope" }),
    });
    assert.equal(badModel.status, 400);

    const response = await fetch(`${base}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "a {red, blue} bird",
        model: "gemini-3-pro-image",
        settings: { version: 1, resolution: "1K", ratio: "1:1", quality: "auto", options: {} },
      }),
    });
    assert.equal(response.status, 200);
    const created = await response.json();
    assert.equal(created.count, 2);

    const jobs = await waitForJobs(base, (list) => list.every((job) => job.state === "done"));
    assert.equal(jobs.length, 2);
    assert.deepEqual(
      jobs.map((job) => job.prompt).sort(),
      ["a blue bird", "a red bird"]
    );
    assert.deepEqual(
      jobs.map((job) => [job.result.width, job.result.height]),
      [[64, 48], [64, 48]]
    );
    assert.equal(calls.length, 2);
    assert.equal(calls[0].settings.resolution, "1K");

    const image = await fetch(`${base}/api/images/${jobs[0].result.file}`);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), PNG);

    // The Affinity bridge script reads these predictable files.
    assert.deepEqual(fs.readFileSync(path.join(dataDir, "images", "latest.png")), PNG);
    assert.deepEqual(fs.readFileSync(path.join(dataDir, "handoff", "latest.png")), PNG);
    assert.ok(fs.existsSync(path.join(dataDir, "handoff", "latest.json")));
    const latest = JSON.parse(fs.readFileSync(path.join(dataDir, "images", "latest.json"), "utf8"));
    assert.equal(latest.file, "latest.png");
    assert.ok(latest.prompt === "a red bird" || latest.prompt === "a blue bird");
    assert.equal(latest.width, 64);

    const state = await (await fetch(`${base}/api/state`)).json();
    assert.equal(state.history.length, 2);
    assert.equal(state.budget.images, 2);
    assert.equal(state.budget.usd.toFixed(2), "0.10");
    assert.equal(state.history[0].label, "Nano Banana Pro (2025)");
  } finally {
    await instance.close();
  }
});

test("describe and currency rates are proxied", async () => {
  const { instance, base } = await start();
  try {
    await fetch(`${base}/api/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ geminiApiKey: "key" }),
    });

    const image = { mimeType: "image/png", base64: PNG.toString("base64") };
    const described = await fetch(`${base}/api/describe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelId: "gemini:gemini-3.7-flash:high", images: [image, image] }),
    });
    assert.equal(described.status, 200);
    const result = await described.json();
    assert.equal(result.descriptions.length, 2);

    const state = await (await fetch(`${base}/api/state`)).json();
    assert.equal(state.budget.imagesAnalyzed, 2);

    const rate = await (await fetch(`${base}/api/rates?currency=EUR`)).json();
    assert.equal(rate.rate, 0.91);
    assert.equal(rate.currency, "EUR");
  } finally {
    await instance.close();
  }
});

test("open and reveal require a stored image", async () => {
  const { instance, base } = await start();
  try {
    const missing = await fetch(`${base}/api/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: "does-not-exist.png" }),
    });
    assert.equal(missing.status, 404);

    const file = instance.store.writeImage(1, "image/png", PNG);
    const opened = await fetch(`${base}/api/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file }),
    });
    assert.deepEqual(await opened.json(), { ok: true, app: "Affinity", file: "1.png" });

    const reveal = await fetch(`${base}/api/reveal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file }),
    });
    assert.equal(reveal.status, 200);
  } finally {
    await instance.close();
  }
});

test("canceling a dispatched request keeps its estimate in the budget", async () => {
  const { instance, base } = await start({
    generateImage: (request) => {
      request.onDispatch?.();
      return new Promise((_, reject) => {
        request.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("Aborted"), { name: "AbortError" }))
        );
      });
    },
  });
  try {
    await fetch(`${base}/api/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ geminiApiKey: "key" }),
    });

    const created = await (
      await fetch(`${base}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "a slow harbour" }),
      })
    ).json();

    await waitForJobs(base, (jobs) => jobs.some((job) => job.state === "running"));
    const canceled = await fetch(`${base}/api/jobs/${created.jobs[0].id}/cancel`, { method: "POST" });
    assert.equal((await canceled.json()).canceled, true);

    await waitForJobs(base, (jobs) => jobs.every((job) => job.state === "cancelled"));
    const state = await (await fetch(`${base}/api/state`)).json();
    assert.equal(state.budget.cancelled, 1);
    assert.equal(state.budget.usd.toFixed(3), "0.144");
    assert.equal(state.history.length, 0);
  } finally {
    await instance.close();
  }
});
