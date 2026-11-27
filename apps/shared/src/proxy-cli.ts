#!/usr/bin/env node
// Tiny CLI wrapper around startProxy(). Each app's `dev` script runs this (via tsx) to
// spin up the browser↔MCP bridge alongside Vite:
//
//   tsx ../shared/src/proxy-cli.ts
//
// Reads PROXY_PORT / PROXY_TOKEN / WEB_URL / WEB_PORT from the environment and prints the
// connect URL (with ?proxyToken / ?proxyPort) so you can open the app pre-wired to this proxy.
// WEB_PORT lets each app pin its Vite port (see its `dev` script) so the printed URL is correct.

import { readFileSync, existsSync } from "node:fs";
import { startProxy, type TargetRule } from "./proxy.js";

const port = Number(process.env.PROXY_PORT ?? 6280);
const webUrl = process.env.WEB_URL ?? `http://localhost:${process.env.WEB_PORT ?? 5173}`;

// Safe by default: only targets matching ./proxy-allow.json (relative to the app dir the script
// runs in) may be dialed; with no file, nothing may. An app whose whole job is launching whatever
// the user types opts in explicitly with PROXY_ALLOW_ANY=1 (warns at startup).
const allowFile = process.env.PROXY_ALLOW_FILE ?? "proxy-allow.json";
const allowTargets: TargetRule[] = existsSync(allowFile) ? JSON.parse(readFileSync(allowFile, "utf8")) : [];
const allowAnyTarget = process.env.PROXY_ALLOW_ANY === "1";
if (!allowAnyTarget && allowTargets.length === 0) console.warn(`  ! no targets allowed: add ${allowFile} (or set PROXY_ALLOW_ANY=1)`);

const proxy = await startProxy({
  port,
  token: process.env.PROXY_TOKEN,
  webUrl,
  allowTargets,
  allowAnyTarget,
});

console.log(`\n  ⬡ mcp-query proxy  ${proxy.url}`);
console.log(`  → Open:  ${webUrl}/?proxyToken=${proxy.token}&proxyPort=${port}\n`);

const shutdown = () => { void proxy.close().then(() => process.exit(0)); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
