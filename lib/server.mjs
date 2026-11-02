/*
 * Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Affinity edition: see LICENSE-EXCEPTION.
 *
 * Local HTTP host for the panel. Browsers cannot call the OpenAI API directly and
 * cannot write files next to an Affinity document, so this server owns credentials,
 * provider requests, spending totals and the saved results.
 */

import { Buffer } from "node:buffer";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { closeAffinitySessions, placeInAffinity as defaultPlace } from "./affinity-mcp.mjs";
import { openInAffinity as defaultOpen, revealFile as defaultReveal } from "./affinity.mjs";
import { addDescriptionToBudget, addToBudget, budgetCounts, formatDate } from "./budget.mjs";
import { DEFAULT_DESCRIPTION_MODEL, DESCRIPTION_MODELS, descriptionModelSpec } from "./description-models.mjs";
import { imageDimensions } from "./image-info.mjs";
import { JobQueue } from "./jobs.mjs";
import { MAX_BRACKET_GENERATION_JOBS, MAX_CONCURRENT_GENERATIONS, MAX_MANUAL_GENERATION_JOBS } from "./limits.mjs";
import {
  DEFAULT_MODEL,
  MODELS,
  actualUsageUSD,
  estimatedTotalUSD,
  modelSpec,
  normalizeModelSettings,
  outputSizeFor,
  validCost,
  validateModelInput,
} from "./models.mjs";
import { expandPromptTemplate } from "./prompt-expansion.mjs";
import { describeImages as defaultDescribe, errorMessage, generateImage as defaultGenerate } from "./providers.mjs";
import { createStore } from "./store.mjs";

const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PUBLIC_DIR = path.join(PACKAGE_ROOT, "public");
const LIB_DIR = path.join(PACKAGE_ROOT, "lib");

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

export const CURRENCIES = ["EUR", "CHF", "USD", "JPY", "KRW", "CNY", "GBP", "CAD", "AUD", "INR", "BRL"];

// Affinity's bridge script reads whichever of these the last result produced.
const RESULT_FILES = ["latest.png", "latest.jpg", "latest.webp"];

const MAX_BODY_BYTES = 96 * 1024 * 1024;
const RATE_TTL_MS = 6 * 60 * 60 * 1000;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, "The upload is too large. Use smaller reference images."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        resolve(parsed && typeof parsed === "object" ? parsed : {});
      } catch {
        reject(new HttpError(400, "The request body was not valid JSON."));
      }
    });
    req.on("error", reject);
  });
}

function decodeBase64Image(value, field) {
  if (!value || typeof value.base64 !== "string" || !value.base64) return null;
  const mimeType = typeof value.mimeType === "string" && value.mimeType ? value.mimeType : "image/png";
  if (!/^image\/(png|jpe?g|webp)$/i.test(mimeType)) {
    throw new HttpError(400, `${field} must be a PNG, JPEG or WebP image.`);
  }
  return { mimeType, base64: value.base64, bytes: Buffer.from(value.base64, "base64") };
}

// Fixed paths compile to equality checks; patterns to one regular expression.
function compileRoute(route) {
  if (typeof route.path === "string") {
    const exact = route.path;
    return { ...route, match: (pathname) => (pathname === exact ? [] : null) };
  }
  return { ...route, match: (pathname) => route.pattern.exec(pathname)?.slice(1) ?? null };
}

export function createServer({ dataDir, handoffDir, services = {} } = {}) {
  const store = createStore(dataDir, { handoffDir });
  const generate = services.generateImage || defaultGenerate;
  const describe = services.describeImages || defaultDescribe;
  const openFile = services.openFile || defaultOpen;
  const revealFile = services.revealFile || defaultReveal;
  const place = services.placeInAffinity || defaultPlace;
  const fetchImpl = services.fetch || globalThis.fetch;

  const rateCache = new Map();

  const queue = new JobQueue({
    concurrency: MAX_CONCURRENT_GENERATIONS,
    run: (job, signal) => runJob(job, signal),
  });

  function publicSettings() {
    const settings = store.settings();
    return {
      displayCurrency: settings.displayCurrency,
      model: settings.model,
      modelPreferences: settings.modelPreferences,
      describeModel: settings.describeModel,
      includeCanvas: settings.includeCanvas,
      affinityApp: settings.affinityApp,
      autoPlace: Boolean(settings.autoPlace),
      hasGeminiKey: Boolean(settings.geminiApiKey),
      hasOpenAIKey: Boolean(settings.openaiApiKey),
    };
  }

  function state() {
    const budget = store.budget();
    return {
      settings: publicSettings(),
      budget: { ...budget, counts: budgetCounts(budget), sinceLabel: formatDate(budget.since) },
      jobs: queue.snapshot(),
      history: store.history(),
      dataDir: store.dataDir,
      handoffDir: store.handoffDir,
      models: MODELS.map((model) => model.id),
      descriptionModels: DESCRIPTION_MODELS.map((model) => model.id),
      currencies: CURRENCIES,
      defaults: { model: DEFAULT_MODEL, describeModel: DEFAULT_DESCRIPTION_MODEL },
      limits: {
        manual: MAX_MANUAL_GENERATION_JOBS,
        concurrency: MAX_CONCURRENT_GENERATIONS,
        bracket: MAX_BRACKET_GENERATION_JOBS,
      },
    };
  }

  // The key for the selected model's provider, or the message that tells the user
  // which key to save. Only that provider's key is ever read.
  function apiKeyFor(spec) {
    const settings = store.settings();
    const openai = spec.provider === "openai";
    const key = openai ? settings.openaiApiKey : settings.geminiApiKey;
    if (!key) throw new HttpError(400, `Enter your ${openai ? "OpenAI" : "Gemini"} API key in Basic Settings and press Save.`);
    return key;
  }

  async function runJob(job, signal) {
    const spec = modelSpec(job.model);
    job.status = `Generating with ${spec.label}…`;
    try {
      const result = await generate({
        apiKey: job.apiKey,
        model: job.model,
        prompt: job.prompt,
        settings: job.settings,
        canvasPng: job.canvasBuffer,
        references: job.references,
        signal,
        onDispatch: () => {
          job.dispatched = true;
          job.status = "Request sent — waiting for the image…";
        },
      });

      // Record the charge before decoding or saving so a local failure keeps billing.
      const actual = validCost(result.costUSD) ?? (result.usage ? actualUsageUSD(spec, result.usage) : null);
      const charge = actual ?? job.estimateUSD ?? null;
      addToBudget(store, charge);

      const bytes = Buffer.from(result.bytes);
      const dimensions = imageDimensions(bytes);
      const file = store.writeImage(job.id, result.mimeType, bytes);
      store.writeLatest(result.mimeType, bytes, {
        jobId: job.id,
        prompt: job.prompt,
        model: job.model,
        width: dimensions?.width ?? null,
        height: dimensions?.height ?? null,
      });

      const resultPayload = {
        file,
        mimeType: result.mimeType,
        width: dimensions?.width ?? null,
        height: dimensions?.height ?? null,
        usd: charge,
        quality: result.usage?.quality ?? null,
      };
      job.result = resultPayload;
      job.width = resultPayload.width;
      job.height = resultPayload.height;
      job.state = "done";
      job.status = "Ready — copy it into Affinity.";
      store.addHistory({
        id: `generation-${job.id}-${Date.now()}`,
        createdAt: new Date().toISOString(),
        prompt: job.prompt,
        model: job.model,
        label: spec.label,
        settings: job.settings,
        file: resultPayload.file,
        mimeType: resultPayload.mimeType,
        width: resultPayload.width,
        height: resultPayload.height,
        usd: charge,
        references: job.storedReferences,
      });

      // Placement goes through Affinity's own scripting bridge, so a user with the
      // bridge enabled gets the layer without touching the clipboard.
      if (store.settings().autoPlace) {
        let placement;
        try {
          placement = await place({ file: store.imagePath(resultPayload.file), handoffDir: store.handoffDir });
        } catch (error) {
          placement = { ok: false, message: errorMessage(error) };
        }
        job.placement = placement;
        job.status = placement.ok ? "Ready — placed in Affinity." : `Ready — placement failed: ${placement.message}`;
      }
    } catch (error) {
      if (job.cancelRequested || error?.name === "AbortError") {
        // A request already dispatched may still be billed; keep its estimate.
        if (job.dispatched) addToBudget(store, job.estimateUSD ?? null, true);
        job.state = "cancelled";
        job.status = job.dispatched
          ? "Canceled after the request was sent — it still counts as billed."
          : "Canceled before anything was sent — nothing was charged.";
        return;
      }
      job.state = "failed";
      job.error = errorMessage(error);
      job.status = `Error: ${job.error}`;
    }
  }

  async function handleGenerate(body) {
    const prompt = String(body.prompt || "").trim();
    if (!prompt) throw new HttpError(400, "Enter a prompt describing the edit.");

    const modelId = typeof body.model === "string" && body.model ? body.model : DEFAULT_MODEL;
    let spec;
    try {
      spec = modelSpec(modelId);
    } catch (error) {
      throw new HttpError(400, errorMessage(error));
    }

    const { settings, notes } = normalizeModelSettings(
      spec,
      body.settings && typeof body.settings === "object" ? body.settings : {}
    );
    const canvas = decodeBase64Image(body.canvas, "The canvas");
    const references = (Array.isArray(body.references) ? body.references : [])
      .map((reference) => decodeBase64Image(reference, "Each reference"))
      .filter(Boolean)
      .slice(0, spec.inputs.references);

    try {
      validateModelInput(spec, settings, Boolean(canvas), references.length);
    } catch (error) {
      throw new HttpError(400, errorMessage(error));
    }

    const apiKey = apiKeyFor(spec);

    let prompts;
    try {
      prompts = expandPromptTemplate(prompt, MAX_BRACKET_GENERATION_JOBS);
    } catch (error) {
      throw new HttpError(400, `Prompt expansion error: ${errorMessage(error)}`);
    }

    const storedReferences = references.map((reference) => store.writeReference(reference.base64, reference.mimeType));
    const outputSize = outputSizeFor(spec, settings.resolution, settings.ratio) || undefined;
    const estimateUSD = estimatedTotalUSD(spec, settings.resolution, outputSize, settings.quality, settings);
    const requestReferences = references.map(({ mimeType, base64 }) => ({ mimeType, base64 }));

    const created = prompts.map((expandedPrompt) => {
      const job = queue.add({
        id: queue.nextId(),
        prompt: expandedPrompt,
        model: modelId,
        label: spec.label,
        createdAt: new Date().toISOString(),
        settings,
        apiKey,
        canvasBuffer: canvas ? canvas.bytes : undefined,
        references: requestReferences,
        storedReferences,
        estimateUSD,
        width: outputSize ? Number(outputSize.split("x")[0]) : null,
        height: outputSize ? Number(outputSize.split("x")[1]) : null,
      });
      return { id: job.id };
    });

    return { jobs: created, notes, count: created.length, estimateUSD };
  }

  async function handleDescribe(body) {
    const images = (Array.isArray(body.images) ? body.images : [])
      .map((image) => decodeBase64Image(image, "Each image"))
      .filter(Boolean);
    if (!images.length) throw new HttpError(400, "Add a canvas or reference image to describe.");

    let model;
    try {
      model = descriptionModelSpec(typeof body.modelId === "string" && body.modelId ? body.modelId : DEFAULT_DESCRIPTION_MODEL);
    } catch (error) {
      throw new HttpError(400, errorMessage(error));
    }

    const result = await describe({
      model,
      apiKey: apiKeyFor(model),
      images: images.map(({ mimeType, base64 }) => ({ mimeType, base64 })),
    });
    const cost = validCost(result.costUSD);
    addDescriptionToBudget(store, cost, images.length, false, cost === null);
    return { descriptions: result.descriptions, usd: cost };
  }

  // Unknown or unsupported values are ignored so a stale panel cannot corrupt settings.
  function applySettingsPatch(body) {
    const patch = {};
    if (typeof body.geminiApiKey === "string") patch.geminiApiKey = body.geminiApiKey.trim();
    if (typeof body.openaiApiKey === "string") patch.openaiApiKey = body.openaiApiKey.trim();
    if (typeof body.displayCurrency === "string" && CURRENCIES.includes(body.displayCurrency)) {
      patch.displayCurrency = body.displayCurrency;
    }
    if (typeof body.model === "string") {
      try {
        patch.model = modelSpec(body.model).id;
      } catch {
        /* Keep the stored model. */
      }
    }
    if (typeof body.describeModel === "string") {
      try {
        patch.describeModel = body.describeModel ? descriptionModelSpec(body.describeModel).id : "";
      } catch {
        /* Keep the stored describe model. */
      }
    }
    if (typeof body.includeCanvas === "boolean") patch.includeCanvas = body.includeCanvas;
    if (typeof body.affinityApp === "string") patch.affinityApp = body.affinityApp.trim();
    if (typeof body.autoPlace === "boolean") patch.autoPlace = body.autoPlace;
    if (body.modelPreferences && typeof body.modelPreferences === "object") patch.modelPreferences = body.modelPreferences;
    store.saveSettings(patch);
    return state();
  }

  async function exchangeRate(currency) {
    const code = String(currency || "USD").toUpperCase();
    if (!CURRENCIES.includes(code)) throw new HttpError(400, `Unsupported currency: ${currency}`);
    if (code === "USD") return { currency: "USD", rate: 1, date: new Date().toISOString().slice(0, 10) };

    const cached = rateCache.get(code);
    if (cached && Date.now() - cached.fetchedAt < RATE_TTL_MS) return cached.value;

    try {
      const response = await fetchImpl(`https://api.frankfurter.dev/v1/latest?base=USD&symbols=${code}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const json = await response.json();
      const rate = json?.rates?.[code];
      if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) throw new Error("No usable rate.");
      const value = { currency: code, rate, date: typeof json.date === "string" ? json.date : null };
      rateCache.set(code, { value, fetchedAt: Date.now() });
      return value;
    } catch {
      // Keep any cached rate; otherwise the panel shows USD.
      if (cached) return { ...cached.value, stale: true };
      return { currency: code, rate: null, date: null };
    }
  }

  function serveFile(file, res) {
    fs.readFile(file, (error, bytes) => {
      if (error) {
        sendJson(res, 404, { error: "Not found." });
        return;
      }
      res.writeHead(200, {
        "Content-Type": CONTENT_TYPES[path.extname(file).toLowerCase()] || "application/octet-stream",
        "Content-Length": bytes.length,
        "Cache-Control": "no-cache",
      });
      res.end(bytes);
    });
  }

  // The panel is served from public/; the shared modules the panel imports from lib/.
  function serveStatic(pathname, res) {
    let relative;
    try {
      relative = decodeURIComponent(pathname === "/" ? "index.html" : pathname.slice(1));
    } catch {
      sendJson(res, 400, { error: "Bad request." });
      return;
    }
    const inLib = relative.startsWith("lib/");
    const root = inLib ? LIB_DIR : PUBLIC_DIR;
    const target = path.resolve(root, inLib ? path.basename(relative) : relative);
    if (!target.startsWith(root + path.sep)) {
      sendJson(res, 404, { error: "Not found." });
      return;
    }
    serveFile(target, res);
  }

  // Request paths are reduced to a base name and resolved inside the data directory,
  // so a request cannot read or place anything outside it.
  function resultPath(file) {
    const name = path.basename(String(file || ""));
    const target = name ? store.imagePath(name) : "";
    if (!target || !fs.existsSync(target)) throw new HttpError(404, "Generate an image first, then place it in Affinity.");
    return target;
  }

  function newestResultPath() {
    const found = RESULT_FILES.map((name) => store.imagePath(name)).find((target) => fs.existsSync(target));
    if (!found) throw new HttpError(404, "Generate an image first, then place it in Affinity.");
    return found;
  }

  const routes = [
    { method: "GET", path: "/api/state", handle: (_req, res) => sendJson(res, 200, state()) },

    {
      method: "POST",
      path: "/api/settings",
      handle: async (req, res) => sendJson(res, 200, applySettingsPatch(await readBody(req))),
    },

    {
      method: "POST",
      path: "/api/generate",
      handle: async (req, res) => sendJson(res, 200, await handleGenerate(await readBody(req))),
    },

    { method: "GET", path: "/api/jobs", handle: (_req, res) => sendJson(res, 200, { jobs: queue.snapshot() }) },

    {
      method: "POST",
      path: "/api/jobs/cancel-all",
      handle: (_req, res) => {
        queue.cancelAll();
        sendJson(res, 200, { jobs: queue.snapshot() });
      },
    },

    {
      method: "POST",
      pattern: /^\/api\/jobs\/(\d+)\/cancel$/,
      handle: (_req, res, _url, [id]) => {
        const canceled = queue.cancel(Number(id));
        sendJson(res, 200, { canceled, jobs: queue.snapshot() });
      },
    },

    {
      method: "POST",
      path: "/api/describe",
      handle: async (req, res) => sendJson(res, 200, await handleDescribe(await readBody(req))),
    },

    {
      method: "POST",
      path: "/api/budget/reset",
      handle: (_req, res) => {
        store.resetBudget();
        sendJson(res, 200, state());
      },
    },

    {
      method: "GET",
      path: "/api/rates",
      handle: async (_req, res, url) =>
        sendJson(res, 200, await exchangeRate(url.searchParams.get("currency") || "USD")),
    },

    {
      method: "GET",
      pattern: /^\/api\/images\/([A-Za-z0-9._-]+)$/,
      handle: (_req, res, _url, [file]) => serveFile(store.imagePath(file), res),
    },

    {
      method: "GET",
      pattern: /^\/api\/references\/([A-Za-z0-9._-]+)$/,
      handle: (_req, res, _url, [file]) => serveFile(store.referencePath(file), res),
    },

    {
      method: "POST",
      path: "/api/place",
      handle: async (req, res) => {
        const body = await readBody(req);
        const file = body.file ? resultPath(body.file) : newestResultPath();
        sendJson(res, 200, await place({ file, handoffDir: store.handoffDir }));
      },
    },

    {
      method: "POST",
      path: "/api/open",
      handle: async (req, res) => {
        const body = await readBody(req);
        const file = resultPath(body.file);
        const result = await openFile(file, { appName: store.settings().affinityApp });
        sendJson(res, 200, { ...result, file: path.basename(file) });
      },
    },

    {
      method: "POST",
      path: "/api/reveal",
      handle: async (req, res) => {
        const body = await readBody(req);
        const file = resultPath(body.file);
        sendJson(res, 200, { ...(await revealFile(file)), file: path.basename(file) });
      },
    },
  ].map(compileRoute);

  async function route(req, res, url) {
    for (const { method, match, handle } of routes) {
      if (method !== req.method) continue;
      const params = match(url.pathname);
      if (!params) continue;
      await handle(req, res, url, params);
      return;
    }
    if (req.method === "GET") {
      serveStatic(url.pathname, res);
      return;
    }
    sendJson(res, 404, { error: "Not found." });
  }

  const server = http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url || "/", "http://localhost");
    } catch {
      sendJson(res, 400, { error: "Bad request." });
      return;
    }
    route(req, res, url).catch((error) => {
      const status = error instanceof HttpError ? error.status : 500;
      if (status >= 500) console.error("[Mega Musa]", error);
      sendJson(res, status, { error: errorMessage(error) });
    });
  });

  return {
    server,
    store,
    queue,
    state,
    listen(port = 0, host = "127.0.0.1") {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.removeListener("error", reject);
          resolve(server.address());
        });
      });
    },
    close() {
      queue.cancelAll();
      // The bridge session is an open socket; leave it behind and the process cannot exit.
      closeAffinitySessions();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
