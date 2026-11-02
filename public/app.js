/*
 * Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Affinity edition: see LICENSE-EXCEPTION.
 *
 * Panel controller. The browser cannot read an Affinity document, so canvas pixels
 * arrive through the clipboard and results go back the same way.
 */

import {
  DEFAULT_MODEL,
  IMAGE_QUALITY_OPTIONS,
  VISIBLE_MODELS,
  imageQualityLabel,
  modelSpec,
  nearestRatioLabel,
  normalizeModelSettings,
  priceRangeUSD,
  resolutionLabel,
} from "./lib/models.mjs";
import { DEFAULT_DESCRIPTION_MODEL, DESCRIPTION_MODELS } from "./lib/description-models.mjs";
import { MAX_MANUAL_GENERATION_JOBS } from "./lib/limits.mjs";
import { expandPromptTemplate } from "./lib/prompt-expansion.mjs";
import { formatMoney, formatMoneyRange } from "./lib/money.mjs";

const $ = (id) => document.getElementById(id);

const state = {
  settings: {
    displayCurrency: "USD",
    model: DEFAULT_MODEL,
    modelPreferences: {},
    describeModel: "",
    includeCanvas: true,
    affinityApp: "",
    autoPlace: false,
    hasGeminiKey: false,
    hasOpenAIKey: false,
  },
  budget: null,
  jobs: [],
  history: [],
  rates: {},
  references: [],
  canvas: null,
  modelId: "",
  generating: false,
  describing: false,
  pollTimer: null,
};

async function api(path, body) {
  const init = body === undefined
    ? {}
    : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  const response = await fetch(path, init);
  let json = {};
  try {
    json = await response.json();
  } catch {
    /* fall through to the status error */
  }
  if (!response.ok) throw new Error(json.error || `Request failed (HTTP ${response.status}).`);
  return json;
}

// --- Display formatting -----------------------------------------------------

function rateOptions() {
  const currency = state.settings.displayCurrency || "USD";
  const entry = state.rates[currency];
  if (currency === "USD" || !entry || !entry.rate) return { currency: "USD", rate: 1 };
  return { currency, rate: entry.rate };
}

function money(usd) {
  return formatMoney(usd, rateOptions());
}

function moneyRange(low, high) {
  return formatMoneyRange(low, high, rateOptions());
}

function dataUrl(image) {
  return `data:${image.mimeType};base64,${image.base64}`;
}

function setStatus(message, kind = "") {
  const status = $("status");
  status.textContent = message;
  status.className = `status${kind ? ` ${kind}` : ""}`;
}

function setNote(message) {
  $("note").textContent = message || "";
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

function empty(text) {
  return element("div", "empty", text);
}

// --- Menus and model controls ----------------------------------------------

function buildSelect(select, options, value) {
  select.replaceChildren(
    ...options.map((option) => {
      const node = document.createElement("option");
      node.value = option.value;
      node.textContent = option.label;
      return node;
    })
  );
  if (options.some((option) => option.value === value)) select.value = value;
}

function resolutionOptionLabel(spec, token, ratio, quality, settings) {
  const label = resolutionLabel(token);
  // Show an Auto price only when there are no explicit resolution tiers.
  if (token === "auto" && spec.imageSizes.length) return label;
  const range = priceRangeUSD(spec, token, ratio, quality, settings);
  return range ? `${label} / ${moneyRange(range[0], range[1])}` : label;
}

function renderModelOptions(spec, options) {
  const container = $("modelOptions");
  container.replaceChildren();
  for (const field of spec.settings || []) {
    const wrapper = document.createElement("div");
    wrapper.className = "field";
    const key = `opt-${field.key}`;
    if (field.type === "boolean") {
      const row = document.createElement("div");
      row.className = "row";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.id = key;
      input.checked = Boolean(options[field.key]);
      input.addEventListener("change", onModelControlChange);
      const label = document.createElement("label");
      label.htmlFor = key;
      label.textContent = field.label;
      row.append(input, label);
      wrapper.append(row);
    } else if (field.type === "select") {
      const label = document.createElement("label");
      label.className = "label";
      label.htmlFor = key;
      label.textContent = field.label;
      const select = document.createElement("select");
      select.id = key;
      buildSelect(select, field.options, options[field.key]);
      select.addEventListener("change", onModelControlChange);
      wrapper.append(label, select);
    } else if (field.type === "number") {
      const label = document.createElement("label");
      label.className = "label";
      label.htmlFor = key;
      label.textContent = field.label;
      const input = document.createElement("input");
      input.type = "number";
      input.id = key;
      input.value = String(options[field.key]);
      if (field.min !== undefined) input.min = String(field.min);
      if (field.max !== undefined) input.max = String(field.max);
      if (field.step !== undefined) input.step = String(field.step);
      input.addEventListener("change", onModelControlChange);
      wrapper.append(label, input);
    } else {
      const label = document.createElement("label");
      label.className = "label";
      label.htmlFor = key;
      label.textContent = field.label;
      const input = document.createElement("input");
      input.type = "text";
      input.id = key;
      input.value = String(options[field.key]);
      input.addEventListener("change", onModelControlChange);
      wrapper.append(label, input);
    }
    if (field.description) {
      const description = document.createElement("div");
      description.className = "muted";
      description.textContent = field.description;
      wrapper.append(description);
    }
    container.append(wrapper);
  }
}

function renderModelControls(spec, settings) {
  const ratio = settings.ratio;
  const quality = settings.quality;
  buildSelect(
    $("resolution"),
    ["auto", ...spec.imageSizes].map((token) => ({
      value: token,
      label: resolutionOptionLabel(spec, token, ratio, quality, settings),
    })),
    settings.resolution
  );
  $("qualityField").style.display = spec.qualities.length > 1 ? "flex" : "none";
  buildSelect(
    $("quality"),
    spec.qualities.map((value) => ({ value, label: imageQualityLabel(value) })),
    quality
  );
  buildSelect(
    $("ratio"),
    spec.aspectRatios.map((value) => ({ value, label: value })),
    ratio
  );
  renderModelOptions(spec, settings.options);
}

function captureSettings() {
  const spec = modelSpec(state.modelId);
  const options = {};
  for (const field of spec.settings || []) {
    const element = $(`opt-${field.key}`);
    if (!element) continue;
    if (field.type === "boolean") options[field.key] = element.checked;
    else if (field.type === "number") options[field.key] = Number(element.value);
    else options[field.key] = element.value;
  }
  return {
    version: spec.settingsVersion ?? 1,
    resolution: $("resolution").value,
    ratio: $("ratio").value,
    quality: $("quality").value,
    options,
  };
}

function applyModel(modelId, overrides = null) {
  const spec = modelSpec(modelId);
  const stored = state.settings.modelPreferences?.[spec.id] || {};
  const normalized = normalizeModelSettings(spec, overrides ? { ...stored, ...overrides } : stored).settings;
  state.modelId = spec.id;
  if ($("model").value !== spec.id) $("model").value = spec.id;
  renderModelControls(spec, normalized);
  renderReferences();
  renderExpandNote();
}

function persistModel() {
  if (!state.modelId) return;
  const preferences = { ...state.settings.modelPreferences, [state.modelId]: captureSettings() };
  state.settings.modelPreferences = preferences;
  void saveSettings({ model: state.modelId, modelPreferences: preferences }, { silent: true });
}

function refreshResolutionLabels() {
  const spec = modelSpec(state.modelId);
  const settings = captureSettings();
  buildSelect(
    $("resolution"),
    ["auto", ...spec.imageSizes].map((token) => ({
      value: token,
      label: resolutionOptionLabel(spec, token, settings.ratio, settings.quality, settings),
    })),
    settings.resolution
  );
}

function onModelControlChange() {
  persistModel();
  refreshResolutionLabels();
}

// --- Settings ---------------------------------------------------------------

async function saveSettings(patch, { silent = false } = {}) {
  try {
    const next = await api("/api/settings", patch);
    applyState(next, { keepModelControls: true });
    if (!silent) setStatus("Saved.");
    return next;
  } catch (error) {
    setStatus(error.message, "error");
    return null;
  }
}

async function ensureRate() {
  const currency = state.settings.displayCurrency || "USD";
  if (currency === "USD" || state.rates[currency]) return;
  try {
    state.rates[currency] = await api(`/api/rates?currency=${encodeURIComponent(currency)}`);
  } catch {
    /* Keep USD until a rate is available. */
  }
}

function currencyNote() {
  const currency = state.settings.displayCurrency || "USD";
  if (currency === "USD") return "API prices are in USD. No exchange rate needed.";
  const entry = state.rates[currency];
  return entry?.rate
    ? `Frankfurter · ${entry.date || "cached"}. Display estimates only.`
    : "Showing USD until an exchange rate is available.";
}

function renderSettingsSurface() {
  $("geminiKey").placeholder = state.settings.hasGeminiKey ? "Saved — enter a new key to replace" : "Gemini API key";
  $("openaiKey").placeholder = state.settings.hasOpenAIKey ? "Saved — enter a new key to replace" : "OpenAI API key";
  if (document.activeElement !== $("displayCurrency")) $("displayCurrency").value = state.settings.displayCurrency || "USD";
  $("currencyNote").textContent = currencyNote();
  if (document.activeElement !== $("affinityApp")) $("affinityApp").value = state.settings.affinityApp || "";
  $("includeCanvas").checked = Boolean(state.settings.includeCanvas);
  $("autoPlace").checked = Boolean(state.settings.autoPlace);
  if (document.activeElement !== $("describeModel")) {
    const stored = state.settings.describeModel;
    const fallback = DESCRIPTION_MODELS.some((model) => model.id === state.settings.describeModel)
      ? stored
      : DEFAULT_DESCRIPTION_MODEL;
    $("describeModel").value = fallback;
  }
}

function renderBudget() {
  const budget = state.budget;
  if (!budget) return;
  $("budgetTotal").textContent = `Spent since ${budget.sinceLabel}: ${money(budget.usd)}`;
  $("budgetCounts").textContent = budget.counts || "";
}

// --- References and canvas --------------------------------------------------

function renderReferences() {
  const spec = state.modelId ? modelSpec(state.modelId) : null;
  $("refCount").textContent = `${state.references.length}/${spec ? spec.inputs.references : 10}`;
  $("thumbs").replaceChildren(
    ...state.references.map((reference, index) => {
      const wrapper = document.createElement("div");
      wrapper.className = "thumb";
      const image = document.createElement("img");
      image.src = dataUrl(reference);
      image.alt = reference.name || `Reference ${index + 1}`;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "×";
      remove.title = "Remove reference";
      remove.dataset.remove = String(index);
      remove.addEventListener("click", () => {
        state.references.splice(index, 1);
        renderReferences();
      });
      wrapper.append(image, remove);
      return wrapper;
    })
  );
}

function renderCanvas() {
  const canvas = state.canvas;
  $("canvasPreview").hidden = !canvas;
  $("canvasPreview").src = canvas ? dataUrl(canvas) : "";
  $("canvasInfo").textContent = canvas
    ? `${canvas.width || "?"} × ${canvas.height || "?"} pixels — pasted copy ready to edit`
    : "Copy a region in Affinity, then paste here (⌘V / Ctrl+V) or drop an image.";
  $("clearCanvas").disabled = !canvas;
}

function renderExpandNote() {
  const prompt = $("prompt").value.trim();
  const note = $("expandNote");
  if (!prompt) {
    note.textContent = "";
    return;
  }
  try {
    const prompts = expandPromptTemplate(prompt, 10);
    note.textContent = prompts.length > 1 ? `${prompts.length} images will be generated.` : "";
  } catch (error) {
    note.textContent = `Prompt expansion error: ${error.message}`;
  }
}

// --- Queue and history ------------------------------------------------------

function actionButton(label, action, data = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.dataset.action = action;
  for (const [key, value] of Object.entries(data)) {
    if (value !== null && value !== undefined) button.dataset[key] = String(value);
  }
  return button;
}

// Queue and history entries share one card, so their markup cannot drift apart.
function resultCard({ badge, stateClass, thumbFile, prompt, details, actions }) {
  const row = element("div", stateClass ? `job job-${stateClass}` : "job");

  if (badge) {
    const head = element("div", "job-head");
    head.append(element("span", "", badge.left), element("span", "", badge.right));
    row.append(head);
  }

  const body = element("div", "job-body");
  if (thumbFile) {
    const thumb = element("img", "job-thumb");
    thumb.src = `/api/images/${encodeURIComponent(thumbFile)}`;
    thumb.alt = "";
    body.append(thumb);
  }

  const text = element("div", "job-text");
  text.append(element("div", "job-prompt", prompt), element("div", "job-status", details));
  if (actions.length) {
    const bar = element("div", "job-actions");
    bar.append(...actions);
    text.append(bar);
  }
  body.append(text);
  row.append(body);
  return row;
}

function resultActions(file, { reveal = false } = {}) {
  const actions = [
    actionButton("Place in Affinity", "place", { file }),
    actionButton("Copy image", "copy", { file }),
    actionButton("Open in Affinity", "open", { file }),
  ];
  if (reveal) actions.push(actionButton("Show file", "reveal", { file }));
  return actions;
}

function jobRow(job) {
  const actions = [];
  if (["queued", "running"].includes(job.state)) actions.push(actionButton("Cancel", "cancel", { id: job.id }));
  if (job.state === "done" && job.result?.file) actions.push(...resultActions(job.result.file, { reveal: true }));

  const row = resultCard({
    badge: { left: `#${job.id}`, right: job.state },
    stateClass: job.state,
    thumbFile: job.result?.file,
    prompt: job.prompt,
    details: job.status,
    actions,
  });

  if (job.result?.width && job.result?.height) {
    const size = `${job.result.width} × ${job.result.height}`;
    row.append(element("div", "info-line", job.result.usd !== null ? `${size} · ${money(job.result.usd)}` : size));
  }
  return row;
}

function renderQueue() {
  const jobs = [...state.jobs].sort((a, b) => b.id - a.id);
  $("queueList").replaceChildren(...(jobs.length ? jobs.map(jobRow) : [empty("No generations yet.")]));
  updateGenerateButton();
}

function historyRow(entry) {
  const parts = [entry.label || entry.model];
  if (entry.width && entry.height) parts.push(`${entry.width} × ${entry.height}`);
  if (entry.usd !== null && entry.usd !== undefined) parts.push(money(entry.usd));

  return resultCard({
    thumbFile: entry.file,
    prompt: entry.prompt,
    details: parts.join(" · "),
    actions: [
      ...(entry.file ? resultActions(entry.file) : []),
      actionButton("Copy prompt", "copy-prompt", { id: entry.id }),
      actionButton("Load settings", "load", { id: entry.id }),
    ],
  });
}

function renderHistory() {
  const entries = state.history.slice(0, 20);
  $("historyList").replaceChildren(...(entries.length ? entries.map(historyRow) : [empty("No generations yet.")]));
}

// --- Rendering orchestration ------------------------------------------------

function applyState(next, { keepModelControls = false } = {}) {
  state.settings = next.settings;
  state.budget = next.budget;
  state.jobs = next.jobs;
  state.history = next.history;
  if (!state.modelId || (!keepModelControls && state.modelId !== next.settings.model)) {
    applyModel(next.settings.model || DEFAULT_MODEL);
  }
  renderSettingsSurface();
  renderBudget();
  renderCanvas();
  renderQueue();
  renderHistory();
  $("footer").textContent = `Saved results: ${next.dataDir}`;
}

async function refreshState() {
  const next = await api("/api/state");
  await ensureRate();
  applyState(next);
  $("connectionBadge").textContent = "connected";
}

function updateGenerateButton() {
  const active = state.jobs.filter((job) => ["queued", "running"].includes(job.state)).length;
  $("generate").disabled = state.generating || state.describing || active >= MAX_MANUAL_GENERATION_JOBS;
  $("generate").title = active >= MAX_MANUAL_GENERATION_JOBS
    ? `The queue is limited to ${MAX_MANUAL_GENERATION_JOBS} active jobs.`
    : "";
  $("describe").disabled = state.describing || state.generating;
}

function schedulePoll() {
  clearTimeout(state.pollTimer);
  const active = state.jobs.some((job) => ["queued", "running"].includes(job.state));
  state.pollTimer = setTimeout(async () => {
    try {
      const { jobs } = await api("/api/jobs");
      const finished = jobs.some((job) =>
        ["done", "failed", "cancelled"].includes(job.state) &&
        !state.jobs.some((previous) => previous.id === job.id && previous.state === job.state)
      );
      state.jobs = jobs;
      renderQueue();
      if (finished) await refreshState();
    } catch {
      $("connectionBadge").textContent = "offline";
    }
    schedulePoll();
  }, active ? 900 : 3000);
}

// --- Generation -------------------------------------------------------------

async function onGenerate() {
  if (state.generating || state.describing) return;
  const prompt = $("prompt").value.trim();
  if (!prompt) {
    setStatus("Enter a prompt describing the edit.", "error");
    return;
  }

  let settings;
  try {
    settings = captureSettings();
  } catch (error) {
    setStatus(error.message, "error");
    return;
  }

  state.generating = true;
  updateGenerateButton();
  setStatus("Starting…");
  setNote("");

  try {
    const includeCanvas = $("includeCanvas").checked;
    const result = await api("/api/generate", {
      prompt,
      model: state.modelId,
      settings,
      canvas: includeCanvas && state.canvas
        ? { mimeType: state.canvas.mimeType, base64: state.canvas.base64 }
        : null,
      references: state.references.map(({ mimeType, base64 }) => ({ mimeType, base64 })),
    });
    setStatus(
      result.count === 1
        ? `Generation ${result.jobs[0].id} added to the queue.`
        : `${result.count} expanded generations added to the queue.`
    );
    if (result.notes?.length) setNote(result.notes.join(" "));
    await refreshState();
    schedulePoll();
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    state.generating = false;
    updateGenerateButton();
  }
}

async function cancelJob(id) {
  try {
    await api(`/api/jobs/${id}/cancel`, {});
    const { jobs } = await api("/api/jobs");
    state.jobs = jobs;
    renderQueue();
    await refreshState();
  } catch (error) {
    setStatus(error.message, "error");
  }
}

async function copyImageFile(file) {
  try {
    const response = await fetch(`/api/images/${encodeURIComponent(file)}`);
    if (!response.ok) throw new Error("That image is no longer on disk.");
    const blob = await response.blob();
    const png = await toPngBlob(blob);
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
    setStatus("Copied. Switch to Affinity and paste it into your document (⌘V / Ctrl+V).", "ok");
  } catch (error) {
    setStatus(`Could not copy the image: ${error.message} Use Open in Affinity instead.`, "error");
  }
}

async function toPngBlob(blob) {
  if (blob.type === "image/png") return blob;
  const decoded = await decodeImage(blob);
  const canvas = document.createElement("canvas");
  canvas.width = decoded.width;
  canvas.height = decoded.height;
  canvas.getContext("2d").drawImage(decoded.source, 0, 0, decoded.width, decoded.height);
  return canvasToBlob(canvas);
}

async function openResultInAffinity(file) {
  try {
    const result = await api("/api/open", { file });
    if (result.ok) {
      setStatus(`Opened ${result.file}${result.app ? ` in ${result.app}` : " in the default app"}.`, "ok");
    } else {
      setStatus("Affinity was not found. Copy the image and paste it into your document instead.", "error");
    }
  } catch (error) {
    setStatus(error.message, "error");
  }
}

async function placeResult(file) {
  try {
    setStatus("Placing the image in Affinity…");
    const result = await api("/api/place", file ? { file } : {});
    setStatus(result.ok ? "Placed in Affinity as a new layer." : `Affinity did not place it: ${result.message}`, result.ok ? "ok" : "error");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

async function revealResult(file) {
  try {
    const result = await api("/api/reveal", { file });
    if (!result.ok) setStatus("Could not reveal the file in the file manager.", "error");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

async function loadHistoryEntry(entry) {
  if (!entry) return;
  applyModel(entry.model, entry.settings ? { ...entry.settings } : null);
  $("prompt").value = entry.prompt;
  renderExpandNote();

  const references = [];
  for (const reference of entry.references || []) {
    try {
      const response = await fetch(`/api/references/${encodeURIComponent(reference.file)}`);
      if (!response.ok) continue;
      const blob = await response.blob();
      references.push({
        mimeType: reference.mimeType,
        base64: await blobToBase64(blob),
        width: null,
        height: null,
        name: reference.file,
      });
    } catch {
      /* Skip references that are no longer on disk. */
    }
  }
  state.references = references;
  renderReferences();
  setStatus("Loaded the generation settings and references.");
}

// --- Describe ---------------------------------------------------------------

function formatDescriptions(descriptions) {
  if (descriptions.length === 1) return descriptions[0];
  return descriptions.map((description, index) => `Image ${index + 1}:\n${description}`).join("\n\n");
}

async function onDescribe() {
  if (state.describing) return;
  const images = [];
  if ($("includeCanvas").checked && state.canvas) {
    images.push({ mimeType: state.canvas.mimeType, base64: state.canvas.base64 });
  }
  for (const reference of state.references) images.push({ mimeType: reference.mimeType, base64: reference.base64 });
  if (!images.length) {
    setStatus("Paste an Affinity copy or add a reference image to describe.", "error");
    return;
  }

  state.describing = true;
  updateGenerateButton();
  setStatus("Describing images…");
  try {
    const result = await api("/api/describe", { modelId: $("describeModel").value, images });
    $("prompt").value = formatDescriptions(result.descriptions);
    renderExpandNote();
    await refreshState();
    setStatus("Describe replaced the prompt.", "ok");
    if (result.usd !== null && result.usd !== undefined) setNote(`Describe cost ca. ${money(result.usd)}.`);
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    state.describing = false;
    updateGenerateButton();
  }
}

// --- Images in -----------------------------------------------------------------

async function decodeImage(blob) {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(blob);
      return { source: bitmap, width: bitmap.width, height: bitmap.height };
    } catch {
      /* Fall back to an <img> below. */
    }
  }
  const url = URL.createObjectURL(blob);
  const image = new Image();
  await new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = () => reject(new Error("That image could not be read."));
    image.src = url;
  });
  URL.revokeObjectURL(url);
  return { source: image, width: image.naturalWidth, height: image.naturalHeight };
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Could not encode the image."))), "image/png");
  });
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(new Error("Could not read the image."));
    reader.readAsDataURL(blob);
  });
}

// Keep the original bytes unless the model input limit requires scaling.
async function prepareImage(blob, maxEdge) {
  const decoded = await decodeImage(blob);
  const scale = Math.min(1, maxEdge / Math.max(decoded.width || 1, decoded.height || 1));
  if (scale === 1) {
    return {
      mimeType: blob.type === "image/jpg" ? "image/jpeg" : blob.type || "image/png",
      base64: await blobToBase64(blob),
      width: decoded.width,
      height: decoded.height,
      name: blob.name || "image",
    };
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(decoded.width * scale));
  canvas.height = Math.max(1, Math.round(decoded.height * scale));
  canvas.getContext("2d").drawImage(decoded.source, 0, 0, canvas.width, canvas.height);
  return {
    mimeType: "image/png",
    base64: await blobToBase64(await canvasToBlob(canvas)),
    width: canvas.width,
    height: canvas.height,
    name: blob.name || "image",
  };
}

function imageFiles(list) {
  return [...(list || [])].filter((file) => /^image\/(png|jpe?g|webp)$/i.test(file.type));
}

async function addReferences(files) {
  const spec = modelSpec(state.modelId);
  let added = 0;
  for (const file of imageFiles(files)) {
    if (state.references.length >= spec.inputs.references) {
      setStatus(`${spec.label} accepts at most ${spec.inputs.references} reference images.`, "error");
      break;
    }
    try {
      state.references.push(await prepareImage(file, spec.inputs.maxEdge));
      added += 1;
    } catch (error) {
      setStatus(error.message, "error");
    }
  }
  renderReferences();
  if (added) setStatus(`${added} reference image${added === 1 ? "" : "s"} added.`);
}

async function setCanvasFromBlob(blob) {
  const spec = modelSpec(state.modelId);
  try {
    const prepared = await prepareImage(blob, spec.inputs.maxEdge);
    state.canvas = prepared;
    renderCanvas();
    setStatus(`Canvas ready: ${prepared.width} × ${prepared.height}.`);
  } catch (error) {
    setStatus(error.message, "error");
  }
}

async function readClipboardImages() {
  if (!navigator.clipboard?.read) {
    throw new Error("This browser cannot read the clipboard directly. Copy the image, click the canvas box and press ⌘V.");
  }
  const items = await navigator.clipboard.read();
  const images = [];
  for (const item of items) {
    const type = item.types.find((candidate) => /^image\/(png|jpe?g|webp)$/i.test(candidate));
    if (!type) continue;
    images.push(new File([await item.getType(type)], "clipboard", { type }));
  }
  return images;
}

// --- Events -----------------------------------------------------------------

function bindEvents() {
  $("saveGeminiKey").addEventListener("click", async () => {
    const value = $("geminiKey").value.trim();
    const next = await saveSettings({ geminiApiKey: value }, { silent: true });
    if (!next) return;
    $("geminiKey").value = "";
    renderSettingsSurface();
    setStatus(value ? "Gemini key saved." : "Gemini key cleared.", "ok");
  });

  $("saveOpenAIKey").addEventListener("click", async () => {
    const value = $("openaiKey").value.trim();
    const next = await saveSettings({ openaiApiKey: value }, { silent: true });
    if (!next) return;
    $("openaiKey").value = "";
    renderSettingsSurface();
    setStatus(value ? "OpenAI key saved." : "OpenAI key cleared.", "ok");
  });

  $("displayCurrency").addEventListener("change", async () => {
    state.rates = {};
    await saveSettings({ displayCurrency: $("displayCurrency").value }, { silent: true });
    await ensureRate();
    await refreshState();
  });

  $("affinityApp").addEventListener("change", () => {
    void saveSettings({ affinityApp: $("affinityApp").value.trim() }, { silent: true });
  });

  $("model").addEventListener("change", () => {
    applyModel($("model").value);
    persistModel();
    renderBudget();
  });

  $("resolution").addEventListener("change", persistModel);
  $("ratio").addEventListener("change", () => {
    persistModel();
    refreshResolutionLabels();
  });
  $("quality").addEventListener("change", () => {
    persistModel();
    refreshResolutionLabels();
  });

  $("prompt").addEventListener("input", renderExpandNote);
  $("prompt").addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== "Return") return;
    if (!(event.metaKey || event.ctrlKey) || event.isComposing) return;
    event.preventDefault();
    void onGenerate();
  });

  $("includeCanvas").addEventListener("change", () => {
    void saveSettings({ includeCanvas: $("includeCanvas").checked }, { silent: true });
  });

  $("autoPlace").addEventListener("change", () => {
    void saveSettings({ autoPlace: $("autoPlace").checked }, { silent: true });
  });

  $("generate").addEventListener("click", () => void onGenerate());
  $("cancelAll").addEventListener("click", async () => {
    try {
      await api("/api/jobs/cancel-all", {});
      await refreshState();
    } catch (error) {
      setStatus(error.message, "error");
    }
  });

  $("resetBudget").addEventListener("click", async () => {
    try {
      applyState(await api("/api/budget/reset", {}), { keepModelControls: true });
      setStatus("Budget counter reset — counting from today.", "ok");
    } catch (error) {
      setStatus(error.message, "error");
    }
  });

  $("describe").addEventListener("click", () => void onDescribe());

  $("fitCanvas").addEventListener("click", () => {
    if (!state.canvas?.width || !state.canvas?.height) {
      setStatus("Paste an Affinity copy first, then fit the ratio to it.", "error");
      return;
    }
    const spec = modelSpec(state.modelId);
    const label = nearestRatioLabel(`${state.canvas.width}:${state.canvas.height}`, spec.aspectRatios);
    $("ratio").value = label;
    persistModel();
    refreshResolutionLabels();
    setStatus(`Aspect ratio set to ${label}.`);
  });

  $("addRefs").addEventListener("click", () => $("refFiles").click());
  $("refFiles").addEventListener("change", async () => {
    await addReferences($("refFiles").files);
    $("refFiles").value = "";
  });

  $("pasteRef").addEventListener("click", async () => {
    try {
      const files = await readClipboardImages();
      if (!files.length) {
        setStatus("The clipboard holds no image.", "error");
        return;
      }
      await addReferences(files);
    } catch (error) {
      setStatus(error.message, "error");
    }
  });

  $("clearRefs").addEventListener("click", () => {
    state.references = [];
    renderReferences();
  });

  $("pasteCanvas").addEventListener("click", async () => {
    try {
      const files = await readClipboardImages();
      if (!files.length) {
        setStatus("The clipboard holds no image.", "error");
        return;
      }
      await setCanvasFromBlob(files[0]);
    } catch (error) {
      setStatus(error.message, "error");
    }
  });

  $("clearCanvas").addEventListener("click", () => {
    state.canvas = null;
    renderCanvas();
  });

  $("canvasZone").addEventListener("paste", async (event) => {
    const files = imageFiles(event.clipboardData?.files);
    if (!files.length) {
      setStatus("The clipboard holds no image.", "error");
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    await setCanvasFromBlob(files[0]);
  });

  $("canvasZone").addEventListener("dragover", (event) => {
    event.preventDefault();
    $("canvasZone").classList.add("dragging");
  });
  $("canvasZone").addEventListener("dragleave", () => $("canvasZone").classList.remove("dragging"));
  $("canvasZone").addEventListener("drop", async (event) => {
    event.preventDefault();
    $("canvasZone").classList.remove("dragging");
    const files = imageFiles(event.dataTransfer?.files);
    if (files.length) await setCanvasFromBlob(files[0]);
  });

  $("referencesZone").addEventListener("dragover", (event) => {
    event.preventDefault();
    $("referencesZone").classList.add("dragging");
  });
  $("referencesZone").addEventListener("dragleave", () => $("referencesZone").classList.remove("dragging"));
  $("referencesZone").addEventListener("drop", async (event) => {
    event.preventDefault();
    $("referencesZone").classList.remove("dragging");
    await addReferences(event.dataTransfer?.files);
  });

  // Pasting anywhere outside a field adds references, matching the Photoshop panel.
  document.addEventListener("paste", (event) => {
    const target = event.target;
    if (target instanceof HTMLElement && target.closest("#canvasZone")) return;
    const tag = String(target?.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || target?.isContentEditable) return;
    const files = imageFiles(event.clipboardData?.files);
    if (!files.length) return;
    event.preventDefault();
    void addReferences(files);
  });

  for (const list of [$("queueList"), $("historyList")]) list.addEventListener("click", onResultAction);
}

// Queue and history cards use the same data-action names, so one handler serves both.
async function onResultAction(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const { action, id, file } = button.dataset;
  switch (action) {
    case "cancel":
      await cancelJob(Number(id));
      break;
    case "place":
      await placeResult(file);
      break;
    case "copy":
      await copyImageFile(file);
      break;
    case "open":
      await openResultInAffinity(file);
      break;
    case "reveal":
      await revealResult(file);
      break;
    case "copy-prompt": {
      const entry = state.history.find((item) => item.id === id);
      if (!entry) break;
      try {
        await navigator.clipboard.writeText(entry.prompt);
        setStatus("Prompt copied.");
      } catch (error) {
        setStatus(error.message, "error");
      }
      break;
    }
    case "load":
      await loadHistoryEntry(state.history.find((item) => item.id === id));
      break;
    default:
      break;
  }
}

async function boot() {
  buildSelect(
    $("displayCurrency"),
    ["EUR", "CHF", "USD", "JPY", "KRW", "CNY", "GBP", "CAD", "AUD", "INR", "BRL"].map((code) => ({
      value: code,
      label: code,
    })),
    "USD"
  );
  buildSelect(
    $("model"),
    VISIBLE_MODELS.map((model) => ({ value: model.id, label: model.label })),
    DEFAULT_MODEL
  );
  buildSelect(
    $("describeModel"),
    DESCRIPTION_MODELS.map((model) => ({
      value: model.id,
      label: model.estimateRangeUSD
        ? `${model.label} (ca. ${moneyRange(model.estimateRangeUSD[0], model.estimateRangeUSD[1])})`
        : `${model.label} (price unknown)`,
    })),
    DEFAULT_DESCRIPTION_MODEL
  );
  buildSelect(
    $("quality"),
    IMAGE_QUALITY_OPTIONS.map((option) => ({ value: option.value, label: option.label })),
    "auto"
  );

  bindEvents();

  try {
    await refreshState();
    setStatus("Ready. Copy a region in Affinity to edit it, or write a prompt and generate.");
  } catch (error) {
    $("connectionBadge").textContent = "offline";
    setStatus(`Could not reach the local server: ${error.message}`, "error");
  }
  renderExpandNote();
  updateGenerateButton();
  schedulePoll();
}

void boot();
