/*
 * Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Affinity edition: see LICENSE-EXCEPTION.
 *
 * Affinity 3.2 exposes an in-app scripting bridge as an MCP server (Help → AI
 * Automation) on a local port. This module speaks that protocol directly, so the
 * panel can place a generated image without the user running a script by hand.
 *
 * The bridge unlocks execute_script only after a hint has been added and the
 * preamble topic has been requested, so every session opens with both calls.
 */

import fs from "node:fs";
import path from "node:path";

const CLIENT = { name: "mega-musa", version: "0.1" };
const PROTOCOL_VERSION = "2025-11-25";
const HINT = "Mega Musa bridge: place the newest generated PNG as an image layer.";
const DEFAULT_TIMEOUT_MS = 25000;

export function candidateEndpoints(env = process.env) {
  const configured = typeof env.MEGA_MUSA_AFFINITY_MCP === "string" ? env.MEGA_MUSA_AFFINITY_MCP.trim() : "";
  if (configured) return [configured.replace(/\/+$/, "")];
  return ["http://localhost:6767", "http://[::1]:6767", "http://127.0.0.1:6767"];
}

// Affinity under Wine can only read inside its own prefix, so a file from the data
// directory is copied to the visible handoff folder before placement.
export function stageForAffinity(file, handoffDir) {
  const absolute = path.resolve(String(file));
  if (!handoffDir || absolute.includes(`${path.sep}drive_c${path.sep}`)) return absolute;
  fs.mkdirSync(handoffDir, { recursive: true });
  const target = path.join(handoffDir, `latest${path.extname(absolute) || ".png"}`);
  if (path.resolve(target) !== absolute) fs.copyFileSync(absolute, target);
  return target;
}

// Affinity running under Wine sees C: inside the prefix, not the host path.
export function windowsPathFor(file) {
  const absolute = path.resolve(String(file));
  const marker = `${path.sep}drive_c${path.sep}`;
  const index = absolute.indexOf(marker);
  if (index < 0) return absolute;
  const rest = absolute.slice(index + marker.length).split(path.sep).join("\\");
  return `C:\\${rest}`;
}

// The bridge returns the last expression, so this is an IIFE that reports a status line.
export function buildPlaceScript(filePath) {
  const literal = JSON.stringify(String(filePath));
  return `(function () {
  var path = ${literal};
  var raster = require("affinity:raster");
  var nodes = require("/nodes");
  var dom = require("affinity:dom");
  var commands = require("/commands");
  var fs = require("/fs");
  var doc = require("/document").Document.current;
  if (!doc) throw new Error("Open a document in Affinity first.");
  if (!(fs.File.size(path) > 0)) {
    throw new Error("Mega Musa could not read " + path + ". Enable Settings > Default Permissions > Access the file system.");
  }
  var formats = raster.RasterFormat;
  // The document's own colour format is the only one it accepts reliably.
  var order = [String(doc.format || ""), "CMYKA8", "RGBA8", "RGBA16", "RGBAUF", "M8", "M16", "IA8", "IA16", "LABA16", "MF"];
  var tried = {};
  var errors = [];
  for (var i = 0; i < order.length; i++) {
    var name = order[i];
    if (!name || tried[name] || formats[name] === undefined) continue;
    tried[name] = true;
    try {
      var spread = doc.currentSpread;
      var before = spread ? spread.children.length : -1;
      var bitmap = raster.RasterObjectApi.loadBitmapFromFile(path, formats[name]);
      var definition = nodes.ImageNodeDefinition.create(formats[name]);
      dom.ImageNodeDefinitionApi.setBitmap(definition.handle, bitmap);
      var builder = commands.AddChildNodesCommandBuilder.create();
      // Without a target the command is accepted and inserts nothing.
      if (spread) builder.setInsertionTarget(spread);
      builder.addImageNode(definition);
      doc.executeCommand(builder.createCommand(true));
      var after = spread ? spread.children.length : -1;
      console.log("MEGA_MUSA_PLACED " + name + " layers " + before + "->" + after);
      return name;
    } catch (error) {
      errors.push(name + ": " + error);
    }
  }
  throw new Error("Affinity refused the image. " + errors.join(" | "));
})()`;
}

class McpSession {
  constructor({ base, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = globalThis.fetch }) {
    this.base = base;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.nextId = 0;
    this.pending = new Map();
    this.endpoint = null;
    this.closed = false;
    this.onclose = null;
    this.controller = new AbortController();
  }

  async open() {
    const response = await this.fetchImpl(`${this.base}/sse`, {
      headers: { Accept: "text/event-stream" },
      signal: this.controller.signal,
    });
    if (!response.ok || !response.body) throw new Error(`Affinity answered HTTP ${response.status}.`);
    this.pump(response.body.getReader());
    this.endpoint = await this.waitForEndpoint();
    this.messageUrl = new URL(this.endpoint, `${this.base}/`).toString();
  }

  pump(reader) {
    (async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          // The bridge frames events with CRLF; normalise so \n\n is the separator.
          buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r/g, "");
          let boundary;
          while ((boundary = buffer.indexOf("\n\n")) >= 0) {
            const chunk = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const data = chunk
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trim())
              .join("\n");
            if (data) this.onEvent(data);
          }
        }
      } catch {
        /* The stream closed; the waiters below report it. */
      }
      this.fail(new Error("Affinity closed the scripting bridge."));
    })();
  }


  onEvent(data) {
    if (!this.endpoint && /session_id|^\/message/.test(data)) {
      this.endpoint = data;
      return;
    }
    let message;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message || "Affinity reported an error."));
    else pending.resolve(message.result || {});
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    // Lets a shared session drop itself from the cache so the next call reconnects.
    this.onclose?.();
  }

  async waitForEndpoint() {
    const deadline = Date.now() + this.timeoutMs;
    while (!this.endpoint) {
      if (this.closed) throw new Error("Affinity closed the scripting bridge.");
      if (Date.now() > deadline) throw new Error("Affinity did not open a scripting session.");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return this.endpoint;
  }

  async post(message) {
    const response = await this.fetchImpl(this.messageUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify(message),
    });
    if (response.status >= 400) throw new Error(`Affinity rejected the request (HTTP ${response.status}).`);
  }

  request(method, params) {
    if (this.closed) return Promise.reject(new Error("Affinity closed the scripting bridge."));
    const id = (this.nextId += 1);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Affinity did not answer ${method} in time.`));
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.post({ jsonrpc: "2.0", id, method, params }).catch((error) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  async notify(method) {
    await this.post({ jsonrpc: "2.0", method });
  }

  async tool(name, args) {
    const result = await this.request("tools/call", { name, arguments: args || {} });
    const text = (result.content || [])
      .map((part) => part?.text)
      .filter((value) => typeof value === "string")
      .join("\n")
      .trim();
    if (/^ERROR/i.test(text)) throw new Error(text.replace(/^ERROR:\s*/i, ""));
    return text;
  }

  close() {
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(new Error("The Affinity session closed."));
    this.pending.clear();
    this.controller.abort();
  }
}

// Connect and unlock the script engine the way the bridge expects.
async function openSession({ endpoints, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = globalThis.fetch } = {}) {
  let session = null;
  let lastError = null;
  for (const base of endpoints || candidateEndpoints()) {
    const candidate = new McpSession({ base, timeoutMs, fetchImpl });
    try {
      await candidate.open();
      session = candidate;
      break;
    } catch (error) {
      lastError = error;
      candidate.close();
    }
  }
  if (!session) {
    throw new Error(
      `Affinity is not listening (${lastError?.message || "no scripting bridge"}). Open Affinity and enable Help → AI Automation.`
    );
  }

  await session.request("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: CLIENT,
  });
  await session.notify("notifications/initialized");
  try {
    await session.tool("add_sdk_hint", { hint: HINT });
  } catch {
    /* Older builds do not require the hint. */
  }
  try {
    await session.tool("read_sdk_documentation_topic", { filename: "preamble" });
  } catch {
    /* This build ships no preamble topic; execute_script still unlocks. */
  }
  return session;
}

// One session per endpoint: an opening handshake costs three round trips, which is
// most of the latency of a placement.
const sharedSessions = new Map();

function cacheKey(options) {
  // A caller supplying its own transport (tests, alternate bridges) gets a fresh
  // session every time, so stubs never leak between connections.
  if (options.fetchImpl && options.fetchImpl !== globalThis.fetch) return null;
  const endpoints = (options.endpoints || candidateEndpoints()).join(",");
  return `${endpoints}|${options.timeoutMs || DEFAULT_TIMEOUT_MS}`;
}

async function sharedSession(options) {
  const key = cacheKey(options);
  if (!key) return openSession(options);

  const existing = sharedSessions.get(key);
  if (existing) {
    const session = await existing.promise.catch(() => null);
    if (session && !session.closed) return session;
    sharedSessions.delete(key);
  }

  const record = { promise: null, session: null };
  record.promise = openSession(options).then((session) => {
    record.session = session;
    session.onclose = () => {
      if (sharedSessions.get(key) === record) sharedSessions.delete(key);
    };
    return session;
  });
  sharedSessions.set(key, record);
  try {
    return await record.promise;
  } catch (error) {
    if (sharedSessions.get(key) === record) sharedSessions.delete(key);
    throw error;
  }
}

export function closeAffinitySessions() {
  for (const record of sharedSessions.values()) record.session?.close();
  sharedSessions.clear();
}

// Run any bridge tool. A session Affinity closed underneath us (restart, document
// switch) is discarded and replaced once before the error is reported.
export async function callAffinityTool(name, args, options = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const session = await sharedSession(options);
    if (session.closed) {
      lastError = new Error("Affinity closed the scripting bridge.");
      continue;
    }
    try {
      return await session.tool(name, args);
    } catch (error) {
      if (!session.closed) throw error;
      lastError = error;
    }
  }
  throw lastError || new Error("Affinity closed the scripting bridge.");
}

// Connect, unlock the script engine and run the placement script.
export async function placeInAffinity({ file, handoffDir, ...options } = {}) {
  if (!file) return { ok: false, message: "There is no image to place." };
  let staged;
  try {
    staged = stageForAffinity(file, handoffDir);
  } catch (error) {
    return { ok: false, message: `Could not hand the image to Affinity: ${error?.message || error}` };
  }
  const script = buildPlaceScript(windowsPathFor(staged));
  try {
    const text = await callAffinityTool("execute_script", { script }, options);
    return { ok: true, message: text || "Placed in Affinity." };
  } catch (error) {
    return { ok: false, message: error?.message || String(error) };
  }
}
