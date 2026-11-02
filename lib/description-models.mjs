/*
 * Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Affinity edition: see LICENSE-EXCEPTION.
 *
 * Describe model catalog. Shared with the browser panel, so no Node imports.
 */

export const DEFAULT_DESCRIPTION_MODEL = "gemini:gemini-3.7-flash:high";

const GEMINI_RATES = {
  "gemini-3.5-flash-lite": { input: 0.3, output: 2.5 },
  "gemini-3.7-flash": { input: 0.75, output: 3.75 },
};

const OPENAI_RATES = {
  "gpt-5.6-luna": { input: 0.2, output: 1.2 },
  "gpt-5.6-sol": { input: 4, output: 20 },
};

export const DESCRIPTION_MODELS = [
  {
    id: "gemini:gemini-3.5-flash-lite:minimal",
    label: "Gemini Flash-Lite — Thinking: Minimal",
    estimateRangeUSD: [0.001234110823151919, 0.002468221646303838],
    provider: "gemini",
    model: "gemini-3.5-flash-lite",
    effort: "minimal",
    estimatedUSD: 0.0018511662347278786,
  },
  {
    id: "gemini:gemini-3.5-flash-lite:high",
    label: "Gemini Flash-Lite — Thinking: High",
    estimateRangeUSD: [0.0037023324694557573, 0.024682216463038382],
    provider: "gemini",
    model: "gemini-3.5-flash-lite",
    effort: "high",
    estimatedUSD: 0.014192274466247068,
  },
  {
    id: "gemini:gemini-3.7-flash:low",
    label: "Gemini 3.7 Flash — Thinking: Low",
    estimateRangeUSD: [0.002468221646303838, 0.009872886585215353],
    provider: "gemini",
    model: "gemini-3.7-flash",
    effort: "low",
    estimatedUSD: 0.0061705541157595955,
  },
  {
    id: DEFAULT_DESCRIPTION_MODEL,
    label: "Gemini 3.7 Flash — Thinking: High",
    estimateRangeUSD: [0.0061705541157595955, 0.03702332469455757],
    provider: "gemini",
    model: "gemini-3.7-flash",
    effort: "high",
    estimatedUSD: 0.021596939405158586,
  },
  {
    id: "openai:gpt-5.6-luna:none",
    label: "OpenAI Luna — Reasoning: None",
    estimateRangeUSD: [0.001234110823151919, 0.002468221646303838],
    provider: "openai",
    model: "gpt-5.6-luna",
    effort: "none",
    estimatedUSD: 0.0018511662347278786,
  },
  {
    id: "openai:gpt-5.6-luna:high",
    label: "OpenAI Luna — Reasoning: High",
    estimateRangeUSD: [0.002468221646303838, 0.012341108231519191],
    provider: "openai",
    model: "gpt-5.6-luna",
    effort: "high",
    estimatedUSD: 0.0074046649389115145,
  },
  {
    id: "openai:gpt-5.6-sol:none",
    label: "OpenAI Sol — Reasoning: None",
    estimateRangeUSD: [0.012341108231519191, 0.03702332469455757],
    provider: "openai",
    model: "gpt-5.6-sol",
    effort: "none",
    estimatedUSD: 0.024682216463038382,
  },
  {
    id: "openai:gpt-5.6-sol:high",
    label: "OpenAI Sol — Reasoning: High",
    estimateRangeUSD: [0.03702332469455757, 0.18511662347278784],
    provider: "openai",
    model: "gpt-5.6-sol",
    effort: "high",
    estimatedUSD: 0.11106997408367271,
  },
];

export function descriptionModelSpec(id) {
  const model = DESCRIPTION_MODELS.find((item) => item.id === id);
  if (!model) throw new Error(`Description model unavailable: ${id}`);
  return model;
}

export function descriptionTokenCost(model, usage, multiplier = 1) {
  const rates = model.provider === "gemini" ? GEMINI_RATES[model.model] : OPENAI_RATES[model.model];
  if (!rates || !usage) return null;
  const { inputTokens, outputTokens } = usage;
  if (inputTokens === undefined || outputTokens === undefined) return null;
  const cached = usage.cachedInputTokens ?? 0;
  const writes = usage.cacheWriteInputTokens ?? 0;
  if (![inputTokens, outputTokens, cached, writes].every((n) => Number.isFinite(n) && n >= 0)) return null;
  if (cached + writes > inputTokens) return null;
  // Cache pricing: https://developers.openai.com/api/docs/guides/prompt-caching
  const input = inputTokens - cached - writes + cached * 0.1 + writes * 1.25;
  const tier = usage.serviceTier;
  const tierMultiplier = tier === "fast" || tier === "priority" ? 2 : tier === "flex" ? 0.5 : 1;
  return ((input * rates.input + outputTokens * rates.output) / 1000000) * tierMultiplier * multiplier;
}
