/*
 * Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Affinity edition: see LICENSE-EXCEPTION.
 */

import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildPlaceScript, placeInAffinity, stageForAffinity, windowsPathFor } from "../lib/affinity-mcp.mjs";

// Minimal stand-in for Affinity's MCP bridge: an SSE stream plus message posts.
async function startBridge({ scriptResult = "MEGA_MUSA_PLACED CMYKA8" } = {}) {
  const received = [];
  let stream = null;
  const server = http.createServer((req, res) => {
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      res.write("event: endpoint\ndata: /message?session_id=test\n\n");
      stream = res;
      return;
    }
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      res.writeHead(202).end();
      const message = JSON.parse(body);
      received.push(message);
      if (message.id === undefined) return;
      const text = message.params?.name === "execute_script" ? scriptResult : "SUCCESS";
      stream?.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text }] } })}\n\n`);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    received,
    close: () =>
      new Promise((resolve) => {
        stream?.end();
        server.close(resolve);
      }),
  };
}

test("Wine paths are translated to the C: drive Affinity sees", () => {
  assert.equal(
    windowsPathFor("/home/aliyss/.local/share/affinity-v3/drive_c/users/aliyss/Desktop/Mega Musa/latest.png"),
    "C:\\users\\aliyss\\Desktop\\Mega Musa\\latest.png"
  );
  assert.equal(windowsPathFor("/home/aliyss/Desktop/latest.png"), "/home/aliyss/Desktop/latest.png");
});

test("a data-directory file is staged where Wine can read it", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mega-musa-stage-"));
  const source = path.join(dataDir, "images", "latest.png");
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, Buffer.from("89504e47", "hex"));

  const handoff = path.join(dataDir, "prefix", "drive_c", "users", "u", "Desktop", "Mega Musa");
  const staged = stageForAffinity(source, handoff);
  assert.equal(staged, path.join(handoff, "latest.png"));
  assert.ok(fs.existsSync(staged));
  assert.equal(windowsPathFor(staged), "C:\\users\\u\\Desktop\\Mega Musa\\latest.png");
});

test("the placement script carries the path and negotiates the colour format", () => {
  const script = buildPlaceScript("C:\\users\\aliyss\\Desktop\\latest.png");
  assert.match(script, /RasterObjectApi\.loadBitmapFromFile/);
  assert.match(script, /ImageNodeDefinitionApi\.setBitmap\(definition\.handle, bitmap\)/);
  assert.match(script, /addImageNode\(definition\)/);
  // Verified live: without an insertion target the insert is silently a no-op.
  assert.match(script, /setInsertionTarget\(spread\)/);
  assert.match(script, /CMYKA8/);
  assert.ok(script.includes("C:\\\\users\\\\aliyss\\\\Desktop\\\\latest.png"));
});

test("placement initialises the bridge, unlocks scripts and reports success", async () => {
  const bridge = await startBridge();
  try {
    const result = await placeInAffinity({ file: "/tmp/Mega Musa/latest.png", endpoints: [bridge.base] });
    assert.deepEqual(result, { ok: true, message: "MEGA_MUSA_PLACED CMYKA8" });

    const methods = bridge.received.map((message) => message.method);
    assert.equal(methods[0], "initialize");
    assert.ok(methods.includes("notifications/initialized"));
    const tools = bridge.received
      .filter((message) => message.method === "tools/call")
      .map((message) => message.params.name);
    assert.deepEqual(tools, ["add_sdk_hint", "read_sdk_documentation_topic", "execute_script"]);

    const script = bridge.received.find((message) => message.params?.name === "execute_script").params.arguments.script;
    assert.match(script, /ImageNodeDefinition/);
  } finally {
    await bridge.close();
  }
});

test("a failed insert is reported instead of being swallowed", async () => {
  const bridge = await startBridge({ scriptResult: "ERROR: Affinity refused the image." });
  try {
    const result = await placeInAffinity({ file: "/tmp/latest.png", endpoints: [bridge.base] });
    assert.equal(result.ok, false);
    assert.match(result.message, /refused the image/);
  } finally {
    await bridge.close();
  }
});

test("a closed bridge produces a readable message", async () => {
  const result = await placeInAffinity({ file: "/tmp/latest.png", endpoints: ["http://127.0.0.1:9"] });
  assert.equal(result.ok, false);
  assert.match(result.message, /not listening/);
});
