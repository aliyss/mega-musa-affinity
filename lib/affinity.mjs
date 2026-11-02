/*
 * Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Affinity edition: see LICENSE-EXCEPTION.
 *
 * Affinity has no scripting bridge, so results reach the document through the
 * clipboard (paste) or by opening the saved file. These helpers cover the file case.
 */

import { spawn } from "node:child_process";

// Affinity 3 ships as "Affinity"; earlier versions are split into separate apps.
const MAC_APP_NAMES = ["Affinity", "Affinity Photo 2", "Affinity Photo", "Affinity Designer 2", "Affinity Publisher 2"];

export function affinityAppCandidates(platform = process.platform) {
  if (platform === "darwin") return MAC_APP_NAMES;
  return [];
}

export function buildOpenCommand(file, { platform = process.platform, appName = "" } = {}) {
  if (platform === "darwin") {
    if (appName) return ["open", ["-a", appName, file]];
    return ["open", [file]];
  }
  if (platform === "win32") return ["cmd", ["/c", "start", "", file]];
  return ["xdg-open", [file]];
}

export function buildRevealCommand(file, { platform = process.platform } = {}) {
  if (platform === "darwin") return ["open", ["-R", file]];
  if (platform === "win32") return ["explorer", ["/select,", file]];
  return ["xdg-open", [file]];
}

export function runCommand(command, args, { spawnImpl = spawn } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(command, args, { stdio: "ignore", detached: true });
    } catch (error) {
      resolve({ ok: false, error: error?.message || "Could not start the command." });
      return;
    }
    child.on?.("error", (error) => resolve({ ok: false, error: error?.message || "Could not start the command." }));
    child.on?.("exit", (code) => resolve({ ok: code === 0, error: code === 0 ? null : `Exited with code ${code}.` }));
    child.unref?.();
  });
}

// Try each Affinity app name, then fall back to the platform opener.
export async function openInAffinity(file, { platform = process.platform, appName = "", spawnImpl } = {}) {
  if (platform === "darwin") {
    const names = appName ? [appName] : affinityAppCandidates(platform);
    for (const name of names) {
      const result = await runCommand("open", ["-a", name, file], { spawnImpl });
      if (result.ok) return { ok: true, app: name };
    }
  }
  const [command, args] = buildOpenCommand(file, { platform, appName });
  const result = await runCommand(command, args, { spawnImpl });
  return { ok: result.ok, app: null, error: result.error };
}

export async function revealFile(file, { platform = process.platform, spawnImpl } = {}) {
  const [command, args] = buildRevealCommand(file, { platform });
  return runCommand(command, args, { spawnImpl });
}
