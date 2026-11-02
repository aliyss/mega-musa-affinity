/*
 * Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Affinity edition: see LICENSE-EXCEPTION.
 *
 * Model catalog, framing, settings normalization and pricing shared by the host
 * server and the browser panel. This module must stay free of Node and host imports.
 */

export const TIER_ORDER = ["512px", "1K", "2K", "4K"];

// Shared ratio choices exposed by the plugin; dimensions vary by model and resolution.
export const SUPPORTED_ASPECT_RATIOS = [
  { label: "1:1", ratio: 1 },
  { label: "2:3", ratio: 2 / 3 },
  { label: "3:2", ratio: 3 / 2 },
  { label: "3:4", ratio: 3 / 4 },
  { label: "4:3", ratio: 4 / 3 },
  { label: "4:5", ratio: 4 / 5 },
  { label: "5:4", ratio: 5 / 4 },
  { label: "9:16", ratio: 9 / 16 },
  { label: "16:9", ratio: 16 / 9 },
  { label: "21:9", ratio: 21 / 9 },
];

// Log distance treats reciprocal changes equally: 2:1 is midway between 1:1 and 4:1.
export function nearestRatioLabel(want, options) {
  if (!options.length) return "1:1";
  if (options.includes(want)) return want;
  const [ww, wh] = want.split(":").map(Number);
  if (!ww || !wh) return options[0];
  const target = Math.log(ww / wh);
  let best = options[0];
  let bestDist = Infinity;
  for (const option of options) {
    const [ow, oh] = option.split(":").map(Number);
    if (!ow || !oh) continue;
    const dist = Math.abs(Math.log(ow / oh) - target);
    if (dist < bestDist) {
      bestDist = dist;
      best = option;
    }
  }
  return best;
}

// --- OpenAI flexible output sizes -------------------------------------------

// Dimensions use a 16px grid, at most a 3:1 ratio and a fixed pixel budget.
export const G2_MAX_EDGE = 3840;
export const G2_MIN_PX = 655360;
export const G2_MAX_PX = 8294400;

export function floor16(n) {
  return Math.max(16, Math.floor(n / 16) * 16);
}

export function ceil16(n) {
  return Math.max(16, Math.ceil(n / 16) * 16);
}

// Approximate the crop ratio within the size limits and 16px grid. An omitted tier uses
// the crop pixel count, clamped to those limits.
export function gptImage2Size(cropW, cropH, tier) {
  const ratio = Math.min(3, Math.max(1 / 3, cropW / cropH));
  let targetPx;
  if (tier === "4K") targetPx = G2_MAX_PX;
  else if (tier === "2K") targetPx = 4194304;
  else if (tier === "1K") targetPx = 1048576;
  else targetPx = Math.min(G2_MAX_PX, Math.max(G2_MIN_PX, cropW * cropH));

  let w = Math.sqrt(targetPx * ratio);
  let h = Math.sqrt(targetPx / ratio);
  const longest = Math.max(w, h);
  if (longest > G2_MAX_EDGE) {
    const k = G2_MAX_EDGE / longest;
    w *= k;
    h *= k;
  }
  // Round down to avoid exceeding the edge and pixel ceilings.
  w = floor16(w);
  h = floor16(h);
  if (w / h > 3) w = floor16(h * 3);
  if (h / w > 3) h = floor16(w * 3);
  // Rounding down may require restoring the minimum pixel area.
  if (w * h < G2_MIN_PX) {
    const k = Math.sqrt(G2_MIN_PX / (w * h));
    w = Math.min(G2_MAX_EDGE, ceil16(w * k));
    h = Math.min(G2_MAX_EDGE, ceil16(h * k));
  }
  return `${w}x${h}`;
}

export function gptImage2RepresentativeSize(token, ratio) {
  if (token !== "1K" && token !== "2K" && token !== "4K") return null;
  const [rw, rh] = ratio.split(":").map(Number);
  if (!rw || !rh) return gptImage2Size(1000, 1000, token);
  return gptImage2Size(rw * 1000, rh * 1000, token);
}

export function flexibleFrame(spec, tier, width, height) {
  const size = gptImage2Size(width, height, tier === "auto" ? undefined : tier);
  const [w, h] = size.split("x").map(Number);
  return { width: w, height: h, ratio: w / h, label: nearestRatioLabel(`${w}:${h}`, spec.aspectRatios), openaiSize: size };
}

// --- Frames -----------------------------------------------------------------

export function fixedOutputSize(spec, ratio) {
  const match = spec.fixedSizes?.find((size) => size.label === ratio);
  return match?.size || spec.fixedSizes?.[0]?.size || null;
}

export function outputSizeFor(spec, token, ratio) {
  if (spec.resolveFrame) {
    const [w, h] = ratio.split(":").map(Number);
    const frame = spec.resolveFrame(spec, token, w || 1, h || 1);
    return frame.width && frame.height ? `${frame.width}x${frame.height}` : null;
  }
  return fixedOutputSize(spec, ratio);
}

// Snap known tiers by TIER_ORDER; unknown tokens or tierless models use Auto.
export function nearestImageSize(want, spec) {
  if (want === "auto" || !spec.imageSizes.length) return "auto";
  if (spec.imageSizes.includes(want)) return want;
  const wanted = TIER_ORDER.indexOf(want);
  if (wanted < 0) return "auto";
  let best = spec.imageSizes[0];
  let bestDist = Infinity;
  for (const size of spec.imageSizes) {
    const dist = Math.abs(TIER_ORDER.indexOf(size) - wanted);
    if (dist < bestDist) {
      bestDist = dist;
      best = size;
    }
  }
  return best;
}

// --- Quality ----------------------------------------------------------------

export const IMAGE_QUALITY_OPTIONS = [
  { value: "auto", label: "Auto" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "XHigh" },
  { value: "max", label: "Max" },
];

export function normalizeImageQuality(value) {
  return IMAGE_QUALITY_OPTIONS.find((option) => option.value === value)?.value || "auto";
}

export function imageQualityLabel(value) {
  return value[0].toUpperCase() + value.slice(1);
}

// --- Pricing ----------------------------------------------------------------

export const OPENAI_TOKEN_RATES = {
  "openai:gpt-image-2.5-sunburst": { textInput: 5, imageInput: 8, imageOutput: 30 },
  "openai:gpt-image-2.5-flare": { textInput: 5, imageInput: 8, imageOutput: 30 },
  "openai:gpt-image-2": { textInput: 5, imageInput: 8, imageOutput: 30 },
  "openai:gpt-image-1.5": { textInput: 5, imageInput: 8, imageOutput: 32 },
  "openai:gpt-image-1-mini": { textInput: 2, imageInput: 2.5, imageOutput: 8 },
};

// Flexible-size output estimates use the quality factors below and this USD token rate.
export const GPT_IMAGE_2_OUTPUT_USD_PER_MILLION = 30;

export function imageOutputTokens(size, qualityFactor) {
  const match = /^(\d+)x(\d+)$/.exec(size);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  const pixels = width * height;
  const longEdge = Math.max(width, height);
  const shortEdge = Math.min(width, height);
  if (
    !width ||
    !height ||
    width % 16 !== 0 ||
    height % 16 !== 0 ||
    pixels < 655360 ||
    pixels > 8294400 ||
    longEdge > 3840 ||
    longEdge > shortEdge * 3
  ) {
    return null;
  }

  // Match the pricing calculator: round exact half ties to the nearest even integer.
  const shortAxis = (qualityFactor * shortEdge) / longEdge;
  const floor = Math.floor(shortAxis);
  const shortAxisFactor = shortAxis - floor === 0.5 ? floor + (floor % 2) : Math.round(shortAxis);
  const numerator = qualityFactor * shortAxisFactor * (2000000 + pixels);
  return Math.floor((numerator + 3999999) / 4000000);
}

export function imageOutputUSD(size, qualityFactor) {
  const tokens = imageOutputTokens(size, qualityFactor);
  return tokens === null ? null : (tokens * GPT_IMAGE_2_OUTPUT_USD_PER_MILLION) / 1000000;
}

export function qualityPriceUSD(spec, outputSize, quality) {
  if (!outputSize) return null;
  const factor = spec.outputQualityFactors?.[quality];
  if (factor !== undefined) return imageOutputUSD(outputSize, factor);
  return spec.qualityPrices?.[quality]?.[outputSize] ?? null;
}

export function outputPriceRangeUSD(spec, token, outputSize, ratio = "1:1") {
  const size = outputSize || outputSizeFor(spec, token, ratio);
  const low = qualityPriceUSD(spec, size, "low");
  const high = qualityPriceUSD(spec, size, spec.outputQualityFactors?.max ? "max" : "high");
  if (low !== null && high !== null) return [low, high];
  return spec.prices?.[token] || null;
}

// Use a priced explicit quality or fall back to the output price range midpoint.
export function estimatedUSD(spec, token, outputSize, quality = "auto") {
  if (quality !== "auto") {
    const exact = qualityPriceUSD(spec, outputSize || outputSizeFor(spec, token, "1:1"), quality);
    if (exact !== null) return exact;
  }
  const range = outputPriceRangeUSD(spec, token, outputSize || null);
  if (!range) return null;
  return (range[0] + range[1]) / 2;
}

// One flat USD overhead per generation request for all text and image inputs.
export const INPUT_OVERHEAD_USD = 0.01;

export function validCost(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function estimatedTotalUSD(spec, token, outputSize, quality, settings) {
  if (spec.estimateCost) {
    return validCost(
      spec.estimateCost(
        settings || { version: spec.settingsVersion ?? 1, resolution: token, quality, ratio: "1:1", options: {} },
        outputSize
      )
    );
  }
  const output = estimatedUSD(spec, token, outputSize, quality);
  return output === null ? null : output + INPUT_OVERHEAD_USD;
}

// Use response token counts when enough usage data and model rates are available.
export function actualUsageUSD(spec, usage) {
  if (spec.actualCost) return validCost(spec.actualCost(usage));
  const rates = spec.tokenRates;
  if (!rates) return null;
  const outputTokens = usage.outputTokens;
  if (outputTokens === undefined) return null;
  const inputImageTokens = usage.inputImageTokens ?? 0;
  const inputTextTokens =
    usage.inputTextTokens ??
    (usage.inputTokens === undefined ? undefined : Math.max(0, usage.inputTokens - inputImageTokens));
  if (inputTextTokens === undefined) return null;
  const usd =
    (inputTextTokens * rates.textInput + inputImageTokens * rates.imageInput + outputTokens * rates.imageOutput) /
    1000000;
  return validCost(usd);
}

// Menu labels show an exact price at a chosen quality, or the tier's USD range.
export function priceRangeUSD(spec, token, ratio, quality, settings) {
  if (spec.estimateCost) {
    const value = estimatedTotalUSD(spec, token, outputSizeFor(spec, token, ratio) || undefined, quality, settings);
    return value === null ? null : [value, value];
  }
  const size = outputSizeFor(spec, token, ratio);
  if (quality !== "auto") {
    const exact = qualityPriceUSD(spec, size, quality);
    if (exact !== null) return [exact + INPUT_OVERHEAD_USD, exact + INPUT_OVERHEAD_USD];
  }
  const range = outputPriceRangeUSD(spec, token, size, ratio);
  if (!range) return null;
  return [range[0] + INPUT_OVERHEAD_USD, range[1] + INPUT_OVERHEAD_USD];
}

// --- Settings ---------------------------------------------------------------

function fieldValue(field, value) {
  switch (field.type) {
    case "boolean":
      return typeof value === "boolean" ? value : field.default;
    case "text":
      return typeof value === "string" ? value.slice(0, field.maxLength ?? 4096) : field.default;
    case "select":
      return field.options.some((option) => option.value === value) ? value : field.default;
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) return field.default;
      let number = Math.max(field.min ?? -Infinity, Math.min(field.max ?? Infinity, value));
      if (field.step && field.step > 0) {
        number = (field.min ?? 0) + Math.round((number - (field.min ?? 0)) / field.step) * field.step;
      }
      return Math.max(field.min ?? -Infinity, Math.min(field.max ?? Infinity, number));
    }
    default:
      return field.default;
  }
}

export function normalizeModelSettings(spec, saved = {}) {
  const notes = [];
  const version = spec.settingsVersion ?? 1;
  let source = saved;
  if (source.version !== undefined && source.version !== version) {
    try {
      source = source.version < version && spec.migrateSettings ? spec.migrateSettings(source) : {};
    } catch {
      source = {};
    }
    notes.push(`${spec.label}: settings version changed; supported settings were restored.`);
  }
  const resolution = nearestImageSize(
    typeof source.resolution === "string" ? source.resolution : spec.defaults.resolution,
    spec
  );
  const ratio = nearestRatioLabel(typeof source.ratio === "string" ? source.ratio : spec.defaults.ratio, spec.aspectRatios);
  const wantedQuality = typeof source.quality === "string" ? source.quality : spec.defaults.quality;
  const quality = spec.qualities.includes(wantedQuality)
    ? wantedQuality
    : spec.qualities.includes("high")
      ? "high"
      : spec.defaults.quality;
  const options = {};
  for (const field of spec.settings || []) {
    const value = source.options?.[field.key];
    options[field.key] = fieldValue(field, value);
    if (value !== undefined && value !== options[field.key]) notes.push(`${field.label} was adjusted to a supported value.`);
  }
  if (source.resolution && source.resolution !== resolution) notes.push(`Resolution set to ${resolution}.`);
  if (source.ratio && source.ratio !== ratio) notes.push(`Aspect ratio set to ${ratio}.`);
  if (source.quality && source.quality !== quality) notes.push(`Quality set to ${quality}.`);
  return { settings: { version, resolution, ratio, quality, options }, notes };
}

export function validateModelInput(spec, settings, canvas, references) {
  if (canvas && !spec.inputs.canvas) {
    throw new Error(`${spec.label} does not accept canvas input. Clear Include Affinity canvas.`);
  }
  if (references > spec.inputs.references) {
    throw new Error(`${spec.label} accepts at most ${spec.inputs.references} reference images.`);
  }
  if (spec.inputs.maxImages !== undefined && references + Number(canvas) > spec.inputs.maxImages) {
    throw new Error(`${spec.label} accepts at most ${spec.inputs.maxImages} images including the canvas.`);
  }
  const error = spec.validateSettings?.(settings);
  if (error) throw new Error(error);
}

// --- Catalog ----------------------------------------------------------------

const RATIOS = SUPPORTED_ASPECT_RATIOS.map((ratio) => ratio.label);

export const GPT_IMAGE_2_QUALITY_FACTORS = { low: 16, medium: 48, high: 96 };

export const GPT_IMAGE_25_QUALITY_FACTORS = { low: 16, medium: 24, high: 48, xhigh: 64, max: 96 };

export const OPENAI_FIXED = [
  { ratio: 1, size: "1024x1024", label: "1:1" },
  { ratio: 3 / 2, size: "1536x1024", label: "3:2" },
  { ratio: 2 / 3, size: "1024x1536", label: "2:3" },
];

const GEMINI_DEFINITIONS = [
  {
    id: "gemini-3-pro-image",
    apiModel: "gemini-3-pro-image",
    label: "Nano Banana Pro (2025)",
    imageSizes: ["1K", "2K", "4K"],
    aspectRatios: RATIOS,
    // 1K and 2K share the same output price; Auto is estimated at the 1K default.
    prices: {
      auto: [0.134, 0.134],
      "1K": [0.134, 0.134],
      "2K": [0.134, 0.134],
      "4K": [0.24, 0.24],
    },
  },
  {
    id: "gemini-3.1-flash-image",
    apiModel: "gemini-3.1-flash-image",
    label: "Nano Banana 2 (2026)",
    imageSizes: ["512px", "1K", "2K", "4K"],
    aspectRatios: RATIOS,
    prices: {
      auto: [0.067, 0.067],
      "512px": [0.045, 0.045],
      "1K": [0.067, 0.067],
      "2K": [0.101, 0.101],
      "4K": [0.151, 0.151],
    },
  },
  {
    id: "gemini-2.5-flash-image",
    apiModel: "gemini-2.5-flash-image",
    visible: false,
    label: "Nano Banana (2025)",
    imageSizes: ["1K"],
    aspectRatios: RATIOS,
    prices: { auto: [0.039, 0.039], "1K": [0.039, 0.039] },
  },
];

const OPENAI_DEFINITIONS = [
  ...["gpt-image-2.5-sunburst", "gpt-image-2.5-flare"].map((apiModel) => ({
    id: `openai:${apiModel}`,
    apiModel,
    label: apiModel === "gpt-image-2.5-sunburst" ? "OpenAI Sunburst (2026)" : "OpenAI Flare (2026)",
    imageSizes: ["1K", "2K", "4K"],
    aspectRatios: RATIOS,
    outputQualityFactors: GPT_IMAGE_25_QUALITY_FACTORS,
    qualities: ["auto", "low", "medium", "high", "xhigh", "max"],
    resolveFrame: flexibleFrame,
  })),
  {
    id: "openai:gpt-image-2",
    apiModel: "gpt-image-2",
    outputQualityFactors: GPT_IMAGE_2_QUALITY_FACTORS,
    resolveFrame: flexibleFrame,
    label: "OpenAI GPT Image 2 (2026)",
    imageSizes: ["1K", "2K", "4K"],
    aspectRatios: RATIOS,
  },
  {
    id: "openai:gpt-image-1.5",
    apiModel: "gpt-image-1.5",
    visible: false,
    label: "OpenAI GPT Image 1.5 (2025)",
    imageSizes: [],
    aspectRatios: OPENAI_FIXED.map((preset) => preset.label),
    fixedSizes: OPENAI_FIXED,
    qualityPrices: {
      low: { "1024x1024": 0.009, "1536x1024": 0.013, "1024x1536": 0.013 },
      medium: { "1024x1024": 0.034, "1536x1024": 0.05, "1024x1536": 0.05 },
      high: { "1024x1024": 0.133, "1536x1024": 0.2, "1024x1536": 0.2 },
    },
    prices: { auto: [0.133, 0.2] },
  },
  {
    id: "openai:gpt-image-1",
    apiModel: "gpt-image-1",
    visible: false,
    label: "OpenAI GPT Image 1 (2025)",
    imageSizes: [],
    aspectRatios: OPENAI_FIXED.map((preset) => preset.label),
    fixedSizes: OPENAI_FIXED,
    qualityPrices: {
      low: { "1024x1024": 0.011, "1536x1024": 0.016, "1024x1536": 0.016 },
      medium: { "1024x1024": 0.042, "1536x1024": 0.063, "1024x1536": 0.063 },
      high: { "1024x1024": 0.167, "1536x1024": 0.25, "1024x1536": 0.25 },
    },
    prices: { auto: [0.167, 0.25] },
  },
  {
    id: "openai:gpt-image-1-mini",
    apiModel: "gpt-image-1-mini",
    visible: false,
    label: "OpenAI GPT Image 1 mini (2025)",
    imageSizes: [],
    aspectRatios: OPENAI_FIXED.map((preset) => preset.label),
    fixedSizes: OPENAI_FIXED,
    qualityPrices: {
      low: { "1024x1024": 0.005, "1536x1024": 0.006, "1024x1536": 0.006 },
      medium: { "1024x1024": 0.011, "1536x1024": 0.015, "1024x1536": 0.015 },
      high: { "1024x1024": 0.036, "1536x1024": 0.052, "1024x1536": 0.052 },
    },
    prices: { auto: [0.036, 0.052] },
  },
];

const GEMINI_MODELS = GEMINI_DEFINITIONS.map((model) => ({
  ...model,
  provider: "gemini",
  qualities: ["auto"],
  defaults: { resolution: "2K", ratio: "1:1", quality: "auto" },
  inputs: { canvas: true, references: 10, maxEdge: 4096 },
}));

const OPENAI_MODELS = OPENAI_DEFINITIONS.map((model) => ({
  qualities: ["auto", "low", "medium", "high"],
  ...model,
  tokenRates: OPENAI_TOKEN_RATES[model.id],
  provider: "openai",
  settings: [
    {
      key: "transparent",
      label: "Transparent background",
      type: "boolean",
      default: false,
      description: "Also request transparency in your prompt. Results may vary.",
    },
  ],
  defaults: { resolution: "2K", ratio: "1:1", quality: "low" },
  inputs: { canvas: true, references: 10, maxEdge: 4096 },
}));

export const MODELS = [...GEMINI_MODELS, ...OPENAI_MODELS];

export const VISIBLE_MODELS = MODELS.filter((model) => model.visible !== false);

export const DEFAULT_MODEL = "gemini-3-pro-image";

export function modelSpec(id) {
  const model = MODELS.find((item) => item.id === id);
  if (!model) throw new Error(`Model unavailable: ${id}`);
  return model;
}

// Keep the API/storage token as 512px; display it as part of the K-tier scale.
export function resolutionLabel(token) {
  if (token === "auto") return "Auto";
  if (token === "512px") return "0.5K";
  return token;
}
