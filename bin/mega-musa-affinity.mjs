#!/usr/bin/env node
/*
 * Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Affinity edition: see LICENSE-EXCEPTION.
 */

import { spawn } from "node:child_process";
import { createServer } from "../lib/server.mjs";

function parseArguments(argv) {
  const options = { port: 4767, host: "127.0.0.1", open: true, dataDir: undefined, error: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--port" || argument === "-p") options.port = Number(argv[++index]);
    else if (argument === "--host") options.host = argv[++index];
    else if (argument === "--data-dir") options.dataDir = argv[++index];
    else if (argument === "--no-open") options.open = false;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else if (!options.error) options.error = `Unknown option: ${argument}`;
  }
  return options;
}

function openBrowser(url) {
  const commands = {
    darwin: ["open", [url]],
    win32: ["cmd", ["/c", "start", "", url]],
  };
  const [command, args] = commands[process.platform] || ["xdg-open", [url]];
  try {
    spawn(command, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    /* Opening a browser is best effort. */
  }
}

const options = parseArguments(process.argv.slice(2));

if (options.help) {
  console.log(`Mega Musa for Affinity

Usage: mega-musa-affinity [options]

  --port <number>      Port for the local panel (default 4767)
  --host <address>     Host to bind (default 127.0.0.1)
  --data-dir <path>    Where images, settings and history are stored
  --no-open            Do not open a browser window
  -h, --help           Show this message`);
  process.exit(0);
}

if (options.error) {
  console.error(`${options.error}\nRun with --help for usage.`);
  process.exit(1);
}

if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
  console.error("The port must be an integer between 0 and 65535.");
  process.exit(1);
}

const instance = createServer({ dataDir: options.dataDir });

try {
  const address = await instance.listen(options.port, options.host);
  const url = `http://${options.host}:${address.port}/`;
  console.log(`Mega Musa for Affinity is running at ${url}`);
  console.log(`Images, settings and history: ${instance.store.dataDir}`);
  console.log("Enable Help → AI Automation in Affinity to place results as layers, or copy a result and paste it in.");
  if (options.open) openBrowser(url);
} catch (error) {
  console.error(`Could not start Mega Musa: ${error?.message || error}`);
  process.exit(1);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    void instance.close().finally(() => process.exit(0));
  });
}
