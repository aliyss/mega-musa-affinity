import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_MODEL,
  MODELS,
  VISIBLE_MODELS,
  actualUsageUSD,
  estimatedTotalUSD,
  gptImage2Size,
  modelSpec,
  nearestImageSize,
  nearestRatioLabel,
  normalizeModelSettings,
  outputSizeFor,
  priceRangeUSD,
  resolutionLabel,
  validateModelInput,
} from "../lib/models.mjs";

test("catalog exposes the shared models and a visible default", () => {
  const ids = MODELS.map((model) => model.id);
  assert.ok(ids.includes(DEFAULT_MODEL));
  assert.ok(VISIBLE_MODELS.every((model) => model.visible !== false));
  assert.ok(VISIBLE_MODELS.length >= 5);
  assert.equal(modelSpec(DEFAULT_MODEL).provider, "gemini");
});

test("flexible OpenAI sizes stay on the 16px grid within the limits", () => {
  const size = gptImage2Size(1920, 1080, "2K");
  const [width, height] = size.split("x").map(Number);
  assert.equal(width % 16, 0);
  assert.equal(height % 16, 0);
  assert.ok(width * height <= 8294400);
  assert.ok(Math.max(width, height) <= 3840);
  assert.ok(Math.max(width, height) / Math.min(width, height) <= 3);
});

test("ratio-only models report no pixel size", () => {
  assert.equal(outputSizeFor(modelSpec("gemini-3-pro-image"), "1K", "16:9"), null);
});

test("OpenAI models resolve exact pixel sizes from the ratio", () => {
  assert.equal(outputSizeFor(modelSpec("openai:gpt-image-2"), "4K", "1:1"), "2880x2880");
  const wide = outputSizeFor(modelSpec("openai:gpt-image-2"), "2K", "16:9");
  assert.match(wide, /^\d+x\d+$/);
});

test("Gemini estimates include the flat input overhead", () => {
  const spec = modelSpec("gemini-3-pro-image");
  assert.ok(Math.abs(estimatedTotalUSD(spec, "1K", undefined, "auto", spec.defaults) - 0.144) < 1e-9);
  assert.ok(Math.abs(estimatedTotalUSD(spec, "4K", undefined, "auto", spec.defaults) - 0.25) < 1e-9);
});

test("quality changes the OpenAI price range", () => {
  const spec = modelSpec("openai:gpt-image-2");
  const low = priceRangeUSD(spec, "1K", "1:1", "low");
  const high = priceRangeUSD(spec, "1K", "1:1", "high");
  assert.ok(low[0] > 0);
  assert.ok(high[0] > low[0]);
});

test("nearest ratio uses log distance", () => {
  assert.equal(nearestRatioLabel("16:9", ["1:1", "4:3", "16:9"]), "16:9");
  assert.equal(nearestRatioLabel("7:4", ["1:1", "3:2", "16:9"]), "16:9");
  assert.equal(nearestRatioLabel("1:3", ["1:1", "2:3"]), "2:3");
});

test("resolution tokens snap to a supported tier", () => {
  const spec = modelSpec("gemini-3-pro-image");
  assert.equal(nearestImageSize("auto", spec), "auto");
  // 512px is a known tier but this model starts at 1K.
  assert.equal(nearestImageSize("512px", spec), "1K");
  assert.equal(nearestImageSize("1K", spec), "1K");
  // Unknown tokens fall back to Auto, matching the model table contract.
  assert.equal(nearestImageSize("8K", spec), "auto");
});

test("resolution labels keep the display scale", () => {
  assert.equal(resolutionLabel("512px"), "0.5K");
  assert.equal(resolutionLabel("auto"), "Auto");
});

test("settings normalize out-of-range values and explain why", () => {
  const spec = modelSpec("gemini-3-pro-image");
  const { settings, notes } = normalizeModelSettings(spec, { resolution: "8K", ratio: "5:7", quality: "max" });
  assert.equal(settings.resolution, "auto");
  // 5:7 sits closest to 3:4 on the log scale.
  assert.equal(settings.ratio, "3:4");
  assert.equal(settings.quality, "auto");
  assert.ok(notes.length >= 3);
});

test("OpenAI transparent option defaults to false and survives normalization", () => {
  const spec = modelSpec("openai:gpt-image-2");
  assert.equal(normalizeModelSettings(spec, {}).settings.options.transparent, false);
  assert.equal(normalizeModelSettings(spec, { options: { transparent: true } }).settings.options.transparent, true);
});

test("input validation enforces the reference limit", () => {
  const spec = modelSpec("openai:gpt-image-2");
  const settings = normalizeModelSettings(spec, {}).settings;
  validateModelInput(spec, settings, true, 10);
  assert.throws(() => validateModelInput(spec, settings, false, 11), /at most 10 reference images/);
});

test("token usage converts to USD for OpenAI models", () => {
  const spec = modelSpec("openai:gpt-image-2");
  const usd = actualUsageUSD(spec, { inputTextTokens: 1000, inputImageTokens: 0, outputTokens: 1000000 });
  assert.ok(usd > 0);
  assert.equal(actualUsageUSD(spec, {}), null);
});
