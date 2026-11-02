/*
 * Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Affinity edition: see LICENSE-EXCEPTION.
 *
 * Settings, budget, history and generated files on disk. API keys live in
 * settings.json, which is written with owner-only permissions.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXTENSIONS = { "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/webp": "webp" };

export function extensionFor(mimeType) {
  return EXTENSIONS[String(mimeType || "").toLowerCase()] || "png";
}

export const DEFAULT_SETTINGS = {
  geminiApiKey: "",
  openaiApiKey: "",
  displayCurrency: "USD",
  model: "gemini-3-pro-image",
  modelPreferences: {},
  describeModel: "",
  includeCanvas: true,
  affinityApp: "",
  autoPlace: false,
};

const SETTING_KEYS = new Set(Object.keys(DEFAULT_SETTINGS));

export function defaultDataDir() {
  if (process.env.MEGA_MUSA_HOME) return path.resolve(process.env.MEGA_MUSA_HOME);
  return path.join(os.homedir(), ".mega-musa-affinity");
}

// Affinity scripts can only read folders the user has granted, so results are also
// copied to a visible Desktop folder that the bridge script looks in.
export function defaultHandoffDir() {
  if (process.env.MEGA_MUSA_HANDOFF) return path.resolve(process.env.MEGA_MUSA_HANDOFF);
  const home = os.homedir();
  const desktop = path.join(home, "Desktop");
  if (fs.existsSync(desktop)) return path.join(desktop, "Mega Musa");
  // Affinity under Wine has its own C: drive, so its Desktop lives inside the prefix
  // and not in the home directory that the panel writes to.
  const candidates = [];
  for (const prefix of [path.join(home, ".local", "share", "affinity-v3"), path.join(home, ".wine")]) {
    let users = [];
    try {
      users = fs.readdirSync(path.join(prefix, "drive_c", "users"));
    } catch {
      continue;
    }
    for (const user of users) {
      // Public is a shared folder; Affinity places layers on the signed-in user's desktop.
      if (user === "Public" || user === "Default") continue;
      const candidate = path.join(prefix, "drive_c", "users", user, "Desktop");
      if (fs.existsSync(candidate)) candidates.push({ user, dir: candidate });
    }
  }
  let username = "";
  try {
    username = os.userInfo().username;
  } catch {
    username = "";
  }
  const own = candidates.find((candidate) => candidate.user === username);
  if (own) return path.join(own.dir, "Mega Musa");
  if (candidates.length) return path.join(candidates[0].dir, "Mega Musa");
  return path.join(home, "Mega Musa");
}

function readJson(file, fallback) {
  try {
    const text = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function emptyBudget() {
  return {
    usd: 0,
    images: 0,
    unpriced: 0,
    cancelled: 0,
    imagesAnalyzed: 0,
    analysisCancelled: 0,
    analysisEstimates: 0,
    since: new Date().toISOString(),
  };
}

function finiteCount(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export function createStore(dataDir = defaultDataDir(), { handoffDir = defaultHandoffDir() } = {}) {
  const imagesDir = path.join(dataDir, "images");
  const referencesDir = path.join(dataDir, "references");
  fs.mkdirSync(imagesDir, { recursive: true });
  fs.mkdirSync(referencesDir, { recursive: true });

  const settingsFile = path.join(dataDir, "settings.json");
  const budgetFile = path.join(dataDir, "budget.json");
  const historyFile = path.join(dataDir, "history.json");

  // These files are read by nearly every request, so each is parsed once and kept
  // until this store writes it. Copies are returned so no caller can alias the cache.
  const cache = { settings: null, budget: null, history: null };

  function settings() {
    if (!cache.settings) {
      const merged = { ...DEFAULT_SETTINGS, ...readJson(settingsFile, {}) };
      if (!merged.modelPreferences || typeof merged.modelPreferences !== "object") merged.modelPreferences = {};
      cache.settings = merged;
    }
    return { ...cache.settings, modelPreferences: { ...cache.settings.modelPreferences } };
  }

  function saveSettings(patch) {
    const next = settings();
    for (const [key, value] of Object.entries(patch || {})) {
      if (!SETTING_KEYS.has(key)) continue;
      if (key === "modelPreferences") {
        if (value && typeof value === "object") next.modelPreferences = { ...value };
        continue;
      }
      if (key === "includeCanvas" || key === "autoPlace") {
        next[key] = Boolean(value);
        continue;
      }
      if (typeof value === "string") next[key] = value;
    }
    cache.settings = next;
    writeJson(settingsFile, next);
    return settings();
  }

  function budget() {
    if (!cache.budget) {
      const stored = readJson(budgetFile, null);
      cache.budget = stored
        ? {
          usd: finiteCount(stored.usd),
          images: finiteCount(stored.images),
          unpriced: finiteCount(stored.unpriced),
          cancelled: finiteCount(stored.cancelled),
          imagesAnalyzed: finiteCount(stored.imagesAnalyzed),
          analysisCancelled: finiteCount(stored.analysisCancelled),
          analysisEstimates: finiteCount(stored.analysisEstimates),
          since: typeof stored.since === "string" && stored.since ? stored.since : new Date().toISOString(),
        }
        : emptyBudget();
      writeJson(budgetFile, cache.budget);
    }
    return { ...cache.budget };
  }

  function saveBudget(value) {
    cache.budget = { ...value };
    writeJson(budgetFile, cache.budget);
    return budget();
  }

  function resetBudget() {
    return saveBudget(emptyBudget());
  }

  function history() {
    if (!cache.history) {
      const stored = readJson(historyFile, []);
      cache.history = Array.isArray(stored) ? stored.filter((entry) => entry && typeof entry.id === "string") : [];
    }
    return [...cache.history];
  }

  function addHistory(entry) {
    const entries = [entry, ...history().filter((existing) => existing.id !== entry.id)].slice(0, 100);
    cache.history = entries;
    writeJson(historyFile, entries);
    return [...entries];
  }

  function writeImage(id, mimeType, bytes) {
    const file = `${id}.${extensionFor(mimeType)}`;
    fs.writeFileSync(path.join(imagesDir, file), bytes);
    return file;
  }

  // References are stored once per content hash so recall can reuse them.
  function writeReference(base64, mimeType) {
    const bytes = Buffer.from(base64, "base64");
    const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 32);
    const file = `${hash}.${extensionFor(mimeType)}`;
    const target = path.join(referencesDir, file);
    if (!fs.existsSync(target)) fs.writeFileSync(target, bytes);
    return { hash, mimeType, file };
  }

  // One predictable file for external consumers such as the Affinity bridge script.
  function writeLatest(mimeType, bytes, metadata = {}) {
    const extension = extensionFor(mimeType);
    const file = `latest.${extension}`;
    const record = { file, ...metadata, updatedAt: new Date().toISOString() };
    fs.writeFileSync(path.join(imagesDir, file), bytes);
    writeJson(path.join(imagesDir, "latest.json"), record);
    try {
      fs.mkdirSync(handoffDir, { recursive: true });
      fs.writeFileSync(path.join(handoffDir, file), bytes);
      writeJson(path.join(handoffDir, "latest.json"), record);
    } catch {
      // The handoff copy is a convenience; the data directory remains authoritative.
    }
    return file;
  }

  function referencePath(file) {
    return path.join(referencesDir, path.basename(String(file || "")));
  }

  function imagePath(file) {
    return path.join(imagesDir, path.basename(String(file || "")));
  }

  return {
    dataDir,
    handoffDir,
    imagesDir,
    referencesDir,
    settings,
    saveSettings,
    budget,
    saveBudget,
    resetBudget,
    history,
    addHistory,
    writeImage,
    writeLatest,
    writeReference,
    imagePath,
    referencePath,
  };
}
