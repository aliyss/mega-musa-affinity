/*
 * Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Affinity edition: see LICENSE-EXCEPTION.
 *
 * Provider adapters and error mapping. Request framing matches the Photoshop
 * plugin so the same keys, models and prompts produce the same requests.
 */

import { Buffer } from "node:buffer";
import { descriptionTokenCost } from "./description-models.mjs";
import { actualUsageUSD, modelSpec, normalizeImageQuality, normalizeModelSettings, outputSizeFor, validateModelInput } from "./models.mjs";

const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
const OPENAI_IMAGES_EDITS = "https://api.openai.com/v1/images/edits";
const OPENAI_IMAGES_GENERATIONS = "https://api.openai.com/v1/images/generations";
const OPENAI_RESPONSES = "https://api.openai.com/v1/responses";

export const MAX_DESCRIPTION_OUTPUT_TOKENS = 8192;

export function errorMessage(error) {
  if (typeof error?.message === "string" && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return "Unexpected error.";
}

export function providerError(provider, help, code, message, apiKey) {
  const clean = (value) => (apiKey ? value.split(apiKey).join("[redacted]") : value)
    .replace(/[\s\u0000-\u001f\u007f]+/g, " ")
    .trim();
  // Redact before shortening so a key at the cutoff cannot leak partially.
  const detail = typeof message === "string" ? clean(message) : "";
  const shortened = detail.length > 500 ? `${detail.slice(0, 500)}…` : detail;
  const head = `${clean(provider)}: ${clean(help)}${code ? ` (${clean(code)})` : ""}`;
  return new Error(`${head}${shortened ? ` Server: ${shortened}` : ""}`);
}

export function apiError(provider, value, status, apiKey) {
  const details = Array.isArray(value?.details) ? value.details : [];
  const reason = details.find((detail) => typeof detail?.reason === "string")?.reason;
  const code = reason || value?.status || value?.code || value?.type;
  const label = typeof code === "string" && code
    ? code.toUpperCase()
    : status
      ? `HTTP ${status}`
      : typeof code === "number"
        ? `HTTP ${code}`
        : "";
  const key = String(code || "").toLowerCase();
  let help = "The request failed.";
  if (provider === "OpenAI" && key === "moderation_blocked") {
    const moderation = value?.moderation_details;
    const stage = moderation?.moderation_stage;
    const categories = Array.isArray(moderation?.categories)
      ? [...new Set(moderation.categories.filter((category) => typeof category === "string" && category.trim()))].join(", ")
      : "";
    help = stage === "input" ? "Input blocked" : stage === "output" ? "Generated image blocked" : "Request blocked";
    help += categories ? ` — ${categories}.` : " by a safety check.";
    if (stage === "input") help += " Exact text or image not identified.";
    if (!categories && !(typeof value?.message === "string" && value.message.trim())) {
      help += " The server provided no specific reason.";
    }
  } else if (/credit_balance|insufficient_quota|spend_limit|usage_limit|failed_precondition/.test(key)) {
    help = "Check API credits, billing and account limits before retrying.";
  } else if (/api_key|authentication/.test(key) || status === 401) {
    help = "Check your API key and account access in Basic Settings, then save the key again.";
  } else if (/permission|access_denied/.test(key) || status === 403) {
    help = "Access was denied. Check API permissions and account availability.";
  } else if (/safety|policy|prohibited|blocklist|recitation|spii|refusal|content_filter|bio_policy|escalation/.test(key)) {
    help = "The provider declined or blocked this content. Review your prompt and input images.";
  } else if (/max_tokens|max_output_tokens|max_messages/.test(key)) {
    help = "The output limit was reached. Try fewer images or a shorter request.";
  } else if (/rate_limit|slow_down|resource_exhausted/.test(key) || status === 429) {
    help = "An API rate or usage limit was reached. Wait before retrying; check account limits if it persists.";
  } else if (/cancelled|canceled/.test(key) || status === 499) {
    help = "The provider canceled the request.";
  } else if (/deadline|timeout/.test(key) || status === 504 || status === 408) {
    help = "The request timed out. Completion could not be confirmed.";
  } else if (/server_error|overloaded|unavailable|^internal$/.test(key) || (status && status >= 500)) {
    help = "The service could not complete the request. Try again later.";
  } else if (/not_found/.test(key) || status === 404) {
    help = "The requested model or resource is unavailable. Check the selected model and inputs.";
  } else if (/invalid|unsupported|image_too|image_file_too|image_parse|empty_image|language|malformed/.test(key)
    || status === 400 || status === 422) {
    help = "The request or input format was rejected. Check the settings and images.";
  }
  return providerError(provider, help, label, value?.message, apiKey);
}

// Preserve AbortError identity so cancellation and budget handling still work.
async function requestJsonRaw(provider, url, init) {
  let response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    if (error?.name === "AbortError" || init.signal?.aborted) throw error;
    throw new Error(`${provider}: Could not receive a response. Check your connection. Request completion is unknown.`);
  }
  let json;
  try {
    json = await response.json();
  } catch (error) {
    if (error?.name === "AbortError" || init.signal?.aborted) throw error;
    if (!response.ok) throw apiError(provider, null, response.status);
    throw new Error(`${provider}: The response was unreadable or interrupted. (HTTP ${response.status})`);
  }
  if (!response.ok) {
    const key = init.headers?.["x-goog-api-key"] || init.headers?.Authorization?.replace(/^Bearer /, "");
    throw apiError(provider, json?.error, response.status, key);
  }
  if (!json || typeof json !== "object") throw new Error(`${provider}: The response contained no usable data.`);
  return json;
}

export async function requestJson(provider, url, init) {
  try {
    return await requestJsonRaw(provider, url, init);
  } catch (error) {
    // Providers sometimes echo an invalid key. Never display the submitted key.
    if (error?.name === "AbortError" || init.signal?.aborted) throw error;
    const key = init.headers?.["x-goog-api-key"] || init.headers?.Authorization?.replace(/^Bearer /, "");
    if (key && typeof error?.message === "string") error.message = error.message.split(key).join("[redacted]");
    throw error;
  }
}

// --- Output checks ----------------------------------------------------------

export function checkOpenAIOutput(json, apiKey) {
  if (json?.error) throw apiError("OpenAI", json.error, undefined, apiKey);
  if (["failed", "incomplete", "cancelled", "queued", "in_progress"].includes(json?.status)) {
    if (json.incomplete_details?.reason === "content_filter") {
      throw providerError(
        "OpenAI",
        "Generated output blocked by a safety check. The server provided no specific reason.",
        "CONTENT_FILTER"
      );
    }
    throw apiError("OpenAI", { code: json.incomplete_details?.reason || json.status }, undefined, apiKey);
  }
}

function geminiError(code, input, ratings, message, apiKey) {
  const reasons = {
    SAFETY: "a safety check",
    IMAGE_SAFETY: "an image safety check",
    PROHIBITED_CONTENT: "prohibited content",
    IMAGE_PROHIBITED_CONTENT: "prohibited image content",
    BLOCKLIST: "blocked terms",
    SPII: "potential sensitive personal information",
    RECITATION: "potential reproduction of existing content",
    IMAGE_RECITATION: "potential reproduction of existing image content",
    ESCALATION: "an escalation rule",
  };
  // Ratings can include categories that passed. Only blocked ratings explain a block.
  const categories = Array.isArray(ratings)
    ? [...new Set(ratings
      .filter((rating) => rating?.blocked === true && typeof rating.category === "string"
        && rating.category !== "HARM_CATEGORY_UNSPECIFIED")
      .map((rating) => rating.category.replace(/^HARM_CATEGORY_/, "").replace(/_/g, " ").toLowerCase()))].join(", ")
    : "";
  let help;
  if (input || reasons[code] || categories) {
    const subject = input ? "Input" : code.startsWith("IMAGE_") ? "Generated image" : "Generated output";
    help = `${subject} blocked`;
    help += categories ? ` — ${categories}.` : reasons[code] ? ` by ${reasons[code]}.` : ".";
    if (input) help += " Exact text or image not identified.";
    if (!categories && !reasons[code] && !(typeof message === "string" && message.trim())) {
      help += " The server provided no specific reason.";
    }
  } else if (code === "OTHER" || code === "IMAGE_OTHER") {
    help = "Generation stopped for an unspecified reason.";
  } else if (code === "NO_IMAGE") {
    help = "The model returned no image.";
  } else {
    return apiError("Gemini", { code, message }, undefined, apiKey);
  }
  return providerError("Gemini", help, code, message, apiKey);
}

export function checkGeminiOutput(json, apiKey) {
  const block = json?.promptFeedback?.blockReason;
  if (block && block !== "BLOCK_REASON_UNSPECIFIED") {
    throw geminiError(block, true, json.promptFeedback.safetyRatings, undefined, apiKey);
  }
  for (const candidate of json?.candidates || []) {
    const code = candidate?.finishReason;
    if (code && code !== "STOP" && code !== "FINISH_REASON_UNSPECIFIED") {
      throw geminiError(code, false, candidate.safetyRatings, candidate.finishMessage, apiKey);
    }
  }
}

// --- Image generation -------------------------------------------------------

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function usageFromOpenAI(value) {
  if (!value || typeof value !== "object") return undefined;
  const details = value.input_tokens_details || value.inputTokensDetails || {};
  const quality = value.quality;
  const usage = {
    quality: ["low", "medium", "high", "xhigh", "max", "auto"].includes(quality) ? quality : undefined,
    inputTokens: finiteNumber(value.input_tokens ?? value.inputTokens),
    inputImageTokens: finiteNumber(details.image_tokens ?? details.imageTokens),
    inputTextTokens: finiteNumber(details.text_tokens ?? details.textTokens),
    outputTokens: finiteNumber(value.output_tokens ?? value.outputTokens),
    totalTokens: finiteNumber(value.total_tokens ?? value.totalTokens),
  };
  return Object.values(usage).some((item) => item !== undefined) ? usage : undefined;
}

function mimeExtension(mimeType) {
  if (/jpe?g/i.test(mimeType)) return "jpg";
  if (/webp/i.test(mimeType)) return "webp";
  return "png";
}

function referenceBlob(reference) {
  return new Blob([Buffer.from(reference.base64, "base64")], { type: reference.mimeType });
}

async function generateGemini({ spec, settings, prompt, apiKey, canvasPng, references, signal, onDispatch }) {
  const parts = [{ text: prompt }];
  if (canvasPng) parts.push({ inlineData: { mimeType: "image/png", data: Buffer.from(canvasPng).toString("base64") } });
  for (const reference of references) {
    parts.push({ inlineData: { mimeType: reference.mimeType, data: reference.base64 } });
  }

  const generationConfig = { responseModalities: ["IMAGE"] };
  const aspectRatio = settings.ratio;
  const imageSize = settings.resolution === "auto" ? undefined : settings.resolution;
  if (aspectRatio || imageSize) {
    const imageConfig = {};
    if (aspectRatio) imageConfig.aspectRatio = aspectRatio;
    if (imageSize) imageConfig.imageSize = imageSize;
    generationConfig.imageConfig = imageConfig;
  }
  const init = {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig }),
  };
  if (signal) init.signal = signal;

  if (signal?.aborted) throw Object.assign(new Error("Canceled before dispatch."), { name: "AbortError" });
  await onDispatch?.();
  const json = await requestJson("Gemini", `${GEMINI_ENDPOINT}/${encodeURIComponent(spec.apiModel)}:generateContent`, init);
  checkGeminiOutput(json, apiKey);

  const candidates = json?.candidates || [];
  for (const candidate of candidates) {
    for (const part of candidate?.content?.parts || []) {
      const inline = part.inlineData || part.inline_data;
      if (inline?.data) {
        return {
          mimeType: inline.mimeType || inline.mime_type || "image/png",
          bytes: Buffer.from(inline.data, "base64"),
          usage: undefined,
        };
      }
    }
  }

  let text = "";
  for (const candidate of candidates) {
    for (const part of candidate?.content?.parts || []) {
      if (part.text) text += `${part.text} `;
    }
  }
  const block = json?.promptFeedback?.blockReason || candidates[0]?.finishReason;
  throw new Error(text.trim() || (block ? `No image returned (${block}).` : "No image returned by the model."));
}

async function generateOpenAI({ spec, settings, prompt, apiKey, canvasPng, references, signal, onDispatch }) {
  const size = outputSizeFor(spec, settings.resolution, settings.ratio);
  if (!size) throw new Error(`Could not resolve an output size for ${spec.label}.`);

  const background = settings.options?.transparent ? "transparent" : "auto";
  const textOnly = !canvasPng && references.length === 0;
  const init = { method: "POST", headers: { Authorization: `Bearer ${apiKey}` } };

  if (textOnly) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify({
      model: spec.apiModel,
      prompt,
      n: 1,
      output_format: "png",
      background,
      quality: normalizeImageQuality(settings.quality),
      size,
    });
  } else {
    const form = new FormData();
    form.append("model", spec.apiModel);
    form.append("prompt", prompt);
    form.append("n", "1");
    form.append("output_format", "png");
    form.append("background", background);
    form.append("quality", normalizeImageQuality(settings.quality));
    form.append("size", size);
    if (canvasPng) form.append("image[]", new Blob([canvasPng], { type: "image/png" }), "canvas.png");
    references.forEach((reference, index) => {
      form.append("image[]", referenceBlob(reference), `reference-${index + 1}.${mimeExtension(reference.mimeType)}`);
    });
    init.body = form;
  }
  if (signal) init.signal = signal;

  if (signal?.aborted) throw Object.assign(new Error("Canceled before dispatch."), { name: "AbortError" });
  await onDispatch?.();
  const json = await requestJson("OpenAI", textOnly ? OPENAI_IMAGES_GENERATIONS : OPENAI_IMAGES_EDITS, init);
  checkOpenAIOutput(json, apiKey);

  const first = json?.data?.[0];
  if (!first?.b64_json) throw new Error("No image returned by OpenAI.");
  const rawUsage = json?.usage || first?.usage;
  return {
    mimeType: `image/${json?.output_format || first?.output_format || "png"}`,
    bytes: Buffer.from(first.b64_json, "base64"),
    usage: usageFromOpenAI(rawUsage ? { ...rawUsage, quality: json?.quality || first?.quality } : undefined),
  };
}

export async function generateImage({ apiKey, model, prompt, settings, canvasPng, references = [], signal, onDispatch }) {
  const spec = modelSpec(model);
  const normalized = normalizeModelSettings(spec, settings).settings;
  validateModelInput(spec, normalized, Boolean(canvasPng), references.length);
  if (!apiKey) throw new Error(`Enter your ${credentialLabel(spec.provider)} and press Save.`);

  const options = { spec, settings: normalized, prompt, apiKey, canvasPng, references, signal, onDispatch };
  const result = spec.provider === "gemini" ? await generateGemini(options) : await generateOpenAI(options);
  const actual = actualUsageUSD(spec, result.usage || {});
  return { ...result, costUSD: actual };
}

export function credentialLabel(provider) {
  return provider === "openai" ? "OpenAI API key" : "Gemini API key";
}

// --- Describe ---------------------------------------------------------------

export const DESCRIPTION_INSTRUCTIONS = `Write precise, visually actionable descriptions for an image-generation or image-editing prompt field.

Describe every supplied visual input as concise, modular details. Cover relevant subjects, objects, poses, expressions, composition, style, lighting, color palette, contrast, materials, textures, spatial relationships, viewpoint, framing, depth of field, environment, legible text and distinctive fine details.

Format each description as 4–8 relevant labeled sections. Start every section with a concise uppercase aspect label followed by a colon. On the following lines, provide 2–4 short list items for that category. Begin every item with the literal plain-text characters "- ". Put no blank lines between items and exactly one blank line between sections. Do not use Markdown headings, bold text, numbering or any rich-text formatting.

Each list item must express one distinct attribute and make sense when extracted on its own. Do not refer to another item or rely on earlier context. Avoid ambiguous pronouns and phrases such as "as above" or "the latter". In subject-focused sections, identify visible entity types when useful. In other sections, use neutral functional terms such as "the subject", "the foreground element" or "the backdrop" instead of repeatedly naming the entity. Do not duplicate the same observation across categories. Keep each item concise, typically 4–14 words.

Use this layout:
COMPOSITION:
- The subject centered within a balanced, tightly framed scene
- Strong symmetry across the vertical axis

LIGHTING:
- Soft directional illumination with gentle highlights
- Restrained shadows across the subject

COLOR PALETTE:
- Muted warm tones with a small cool accent
- Low saturation and cohesive tonal harmony

State only what is visibly supported. Do not invent identities, brands, artist names, hidden details, camera settings or intended edits. When something is uncertain, describe it conservatively. Describe the visual content rather than critiquing it, explaining it or proposing changes.

Return exactly one self-contained description for each input in the exact input order. Keep different images separate and do not merge them into one scene. Do not include image labels; the application adds them. Do not include a preamble, conclusion or safety commentary.

Return only the requested sections and list items.`;

export function descriptionSchema(imageCount) {
  return {
    type: "object",
    properties: {
      descriptions: {
        type: "array",
        minItems: imageCount,
        maxItems: imageCount,
        items: { type: "string" },
      },
    },
    required: ["descriptions"],
    additionalProperties: false,
  };
}

export function parseDescriptionJson(text, imageCount) {
  let candidate = text.trim();
  if (candidate.startsWith("```")) {
    candidate = candidate.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  }

  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    throw new Error("The description model returned invalid structured text.");
  }

  const descriptions = parsed?.descriptions;
  if (!Array.isArray(descriptions) || descriptions.length !== imageCount) {
    throw new Error(
      `The description model returned ${Array.isArray(descriptions) ? descriptions.length : 0} descriptions for ${imageCount} inputs.`
    );
  }
  const clean = descriptions.map((description) => (typeof description === "string" ? description.trim() : ""));
  if (clean.some((description) => !description)) {
    throw new Error("The description model returned an empty image description.");
  }
  return clean;
}

function descriptionRequestInit(body, headers, signal) {
  const init = {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  };
  if (signal) init.signal = signal;
  return init;
}

async function describeWithGemini({ model, images, apiKey, signal, onDispatch }) {
  const parts = [{ text: `Describe all ${images.length} supplied visual input${images.length === 1 ? "" : "s"} in exact order.` }];
  for (const image of images) {
    parts.push({
      inlineData: { mimeType: image.mimeType, data: image.base64 },
      mediaResolution: { level: "media_resolution_high" },
    });
  }
  const body = {
    systemInstruction: { parts: [{ text: DESCRIPTION_INSTRUCTIONS }] },
    contents: [{ role: "user", parts }],
    generationConfig: {
      thinkingConfig: { thinkingLevel: model.effort },
      maxOutputTokens: MAX_DESCRIPTION_OUTPUT_TOKENS,
      responseMimeType: "application/json",
      responseJsonSchema: descriptionSchema(images.length),
    },
  };

  if (signal?.aborted) throw Object.assign(new Error("Canceled before dispatch."), { name: "AbortError" });
  await onDispatch?.();
  const json = await requestJson(
    "Gemini",
    `${GEMINI_ENDPOINT}/${encodeURIComponent(model.model)}:generateContent`,
    descriptionRequestInit(body, { "x-goog-api-key": apiKey }, signal)
  );
  const rawUsage = json?.usageMetadata;
  const candidates = finiteNumber(rawUsage?.candidatesTokenCount);
  const thoughts = finiteNumber(rawUsage?.thoughtsTokenCount);
  const usage = rawUsage
    ? {
      inputTokens: finiteNumber(rawUsage.promptTokenCount),
      cachedInputTokens: finiteNumber(rawUsage.cachedContentTokenCount),
      // Gemini reports thinking separately; OpenAI includes it in output_tokens.
      outputTokens: candidates === undefined ? undefined : candidates + (thoughts ?? 0),
      reasoningTokens: thoughts,
      totalTokens: finiteNumber(rawUsage.totalTokenCount),
    }
    : undefined;

  checkGeminiOutput(json, apiKey);
  let text = "";
  for (const candidate of json?.candidates || []) {
    for (const part of candidate?.content?.parts || []) {
      if (!part?.thought && typeof part?.text === "string") text += part.text;
    }
  }
  text = text.trim();
  if (!text) {
    const reason = json?.promptFeedback?.blockReason || json?.candidates?.[0]?.finishReason;
    throw new Error(reason ? `Gemini returned no description (${reason}).` : "Gemini returned no image description.");
  }
  return { descriptions: parseDescriptionJson(text, images.length), usage };
}

async function describeWithOpenAI({ model, images, apiKey, signal, onDispatch }) {
  const body = {
    model: model.model,
    store: false,
    instructions: DESCRIPTION_INSTRUCTIONS,
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: `Describe all ${images.length} supplied visual input${images.length === 1 ? "" : "s"} in exact order.`,
          },
          ...images.map((image) => ({
            type: "input_image",
            image_url: `data:${image.mimeType};base64,${image.base64}`,
            detail: "high",
          })),
        ],
      },
    ],
    reasoning: { effort: model.effort },
    max_output_tokens: MAX_DESCRIPTION_OUTPUT_TOKENS,
    text: {
      format: {
        type: "json_schema",
        name: "image_descriptions",
        strict: true,
        schema: descriptionSchema(images.length),
      },
    },
  };

  if (signal?.aborted) throw Object.assign(new Error("Canceled before dispatch."), { name: "AbortError" });
  await onDispatch?.();
  const json = await requestJson(
    "OpenAI",
    OPENAI_RESPONSES,
    descriptionRequestInit(body, { Authorization: `Bearer ${apiKey}` }, signal)
  );
  const rawUsage = json?.usage;
  const usage = rawUsage
    ? {
      inputTokens: finiteNumber(rawUsage.input_tokens),
      cachedInputTokens: finiteNumber(rawUsage.input_tokens_details?.cached_tokens),
      cacheWriteInputTokens: finiteNumber(rawUsage.input_tokens_details?.cache_write_tokens),
      outputTokens: finiteNumber(rawUsage.output_tokens),
      reasoningTokens: finiteNumber(rawUsage.output_tokens_details?.reasoning_tokens),
      totalTokens: finiteNumber(rawUsage.total_tokens),
      serviceTier: json?.service_tier,
    }
    : undefined;

  checkOpenAIOutput(json, apiKey);
  const pieces = [];
  for (const item of json?.output || []) {
    for (const content of item?.content || []) {
      if (content?.type === "output_text" && typeof content.text === "string") pieces.push(content.text);
      else if (content?.type === "refusal" && content.refusal) {
        throw apiError("OpenAI", { code: "refusal", message: content.refusal }, undefined, apiKey);
      }
    }
  }
  const text = pieces.join("").trim();
  if (!text) throw new Error("OpenAI returned no image description.");
  return { descriptions: parseDescriptionJson(text, images.length), usage };
}

export async function describeImages({ model, images, apiKey, signal, onDispatch }) {
  if (!images.length) throw new Error("Provide at least one image to describe.");
  if (!apiKey) throw new Error(`Enter your ${credentialLabel(model.provider)} and press Save.`);
  const result = model.provider === "openai"
    ? await describeWithOpenAI({ model, images, apiKey, signal, onDispatch })
    : await describeWithGemini({ model, images, apiKey, signal, onDispatch });
  const costUSD = descriptionTokenCost(model, result.usage);
  return { ...result, costUSD };
}
