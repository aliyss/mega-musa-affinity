/**
 * name: Mega Musa — place latest result
 * description: Places the newest Mega Musa generation into the current Affinity document as an image layer.
 * version: 1.0.0
 * author: Sphericals
 *
 * Install: Affinity → Window → General → Scripts → add a category, then add this script.
 * Run it after generating in the Mega Musa panel.
 *
 * Verified against Affinity 3.2 with the SDK reference at https://sdk.affinity.studio.
 * The bitmap must match the document's colour format (a CMYK document rejects an RGBA bitmap
 * with COMMAND_FAILED), so the format is negotiated from the open document.
 *
 * Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 */

"use strict";

const { app } = require("/application");
const { Document } = require("/document");
const { ImageNodeDefinition } = require("/nodes");
const { AddChildNodesCommandBuilder } = require("/commands");
const { File } = require("/fs");

const HANDOFF_FOLDER = "Mega Musa";
const EXTENSIONS = ["png", "jpg", "jpeg", "webp"];
const RASTER_MODULES = ["affinity:raster", "/rasterobject"];
// Documents reject a bitmap whose colour format differs from their own.
const FORMAT_PREFERENCE = ["CMYKA8", "RGBA8", "RGBA16", "RGBAUF", "M8", "M16", "IA8", "IA16", "LABA16", "MF"];

function optionalRequire(name) {
  try {
    return require(name);
  } catch (error) {
    return null;
  }
}

function rasterModules() {
  const found = [];
  for (const name of RASTER_MODULES) {
    const module = optionalRequire(name);
    if (module) found.push(module);
  }
  return found;
}

// The raster API is exposed as RasterObjectApi on affinity:raster, but builds differ.
function rasterApi(modules) {
  for (const module of modules) {
    if (module && typeof module.loadBitmapFromFile === "function") return module;
    if (module && module.RasterObjectApi && typeof module.RasterObjectApi.loadBitmapFromFile === "function") {
      return module.RasterObjectApi;
    }
    if (module && module.RasterObject && typeof module.RasterObject.loadBitmapFromFile === "function") {
      return module.RasterObject;
    }
  }
  return null;
}

function rasterFormats(modules) {
  for (const module of modules) {
    if (module && module.RasterFormat && module.RasterFormat.RGBA8 !== undefined) return module.RasterFormat;
  }
  return null;
}

function nodeApi(modules, name) {
  for (const module of modules) {
    const candidate = module && module[name];
    if (candidate && typeof candidate === "object") return candidate;
  }
  const dom = optionalRequire("affinity:dom");
  return (dom && dom[name]) || null;
}

function desktopPath() {
  try {
    return String(app.getUserDesktopPath);
  } catch (error) {
    return "";
  }
}

function candidatePaths() {
  const desktop = desktopPath();
  if (!desktop) return [];
  const separator = desktop.indexOf("\\") >= 0 ? "\\" : "/";
  return EXTENSIONS.map((extension) => [desktop, HANDOFF_FOLDER, `latest.${extension}`].join(separator));
}

function fileExists(path) {
  try {
    return File.size(path) > 0;
  } catch (error) {
    return false;
  }
}

function latestResultPath() {
  const candidates = candidatePaths();
  for (const path of candidates) {
    if (fileExists(path)) return path;
  }
  throw new Error(
    "No Mega Musa result found. Generate something in the panel first, then run this script again.\n\n" +
      "Looked in:\n" +
      (candidates.length ? candidates.join("\n") : "<Desktop path unavailable>") +
      "\n\nIf the files exist, enable Affinity → Settings → Default Permissions → Access the file system."
  );
}

function documentFormatName(document) {
  try {
    return String(document.format || "");
  } catch (error) {
    return "";
  }
}

function formatCandidates(formats, document) {
  const preferred = documentFormatName(document);
  const names = FORMAT_PREFERENCE.slice();
  const index = names.indexOf(preferred);
  if (index > 0) names.splice(index, 1);
  if (index >= 0) names.unshift(preferred);
  else if (preferred) names.unshift(preferred);
  return names
    .filter((name) => formats && formats[name] !== undefined)
    .map((name) => ({ name, value: formats[name] }));
}

function createImageDefinition(format) {
  if (typeof ImageNodeDefinition.create === "function") return ImageNodeDefinition.create(format);
  const api = nodeApi(rasterModules(), "ImageNodeDefinitionApi");
  if (api && typeof api.create === "function") return api.create(format);
  throw new Error("This Affinity version does not expose ImageNodeDefinition.create.");
}

function applyBitmap(definition, bitmap, modules) {
  if (typeof definition.setBitmap === "function") {
    definition.setBitmap(bitmap);
    return "definition.setBitmap";
  }
  const api = nodeApi(modules, "ImageNodeDefinitionApi");
  if (api && typeof api.setBitmap === "function") {
    api.setBitmap(definition.handle, bitmap);
    return "ImageNodeDefinitionApi.setBitmap";
  }
  throw new Error("This Affinity version does not expose ImageNodeDefinition.setBitmap.");
}

function placeBitmap(document, path, format, modules, api) {
  const bitmap = api.loadBitmapFromFile(path, format);
  const definition = createImageDefinition(format);
  const via = applyBitmap(definition, bitmap, modules);
  const builder = AddChildNodesCommandBuilder.create();
  // Verified: without an insertion target Affinity accepts the command and adds nothing.
  const spread = document.currentSpread;
  if (spread) builder.setInsertionTarget(spread);
  builder.addImageNode(definition);
  document.executeCommand(builder.createCommand(true));
  return via;
}

function placeLatestResult() {
  const document = Document.current;
  if (!document) throw new Error("Open a document before running Mega Musa.");

  const modules = rasterModules();
  const api = rasterApi(modules);
  const formats = rasterFormats(modules);
  if (!api) throw new Error("Affinity's raster API is unavailable in this version.");
  if (!formats) throw new Error("Affinity's raster format enum is unavailable in this version.");

  const path = latestResultPath();
  const attempts = [];
  for (const format of formatCandidates(formats, document)) {
    try {
      return { file: path, format: format.name, via: placeBitmap(document, path, format.value, modules, api) };
    } catch (error) {
      attempts.push(`${format.name}: ${error && error.message ? error.message : error}`);
    }
  }
  throw new Error(
    "Affinity refused the image. Tried colour formats:\n" + attempts.join("\n")
  );
}

function main() {
  try {
    const result = placeLatestResult();
    console.log("Mega Musa placed " + result.file + " as " + result.format + ".");
  } catch (error) {
    app.alert(String((error && error.message) || error), "Mega Musa");
  }
}

module.exports.main = main;
module.exports.placeLatestResult = placeLatestResult;

main();
