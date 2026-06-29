#!/usr/bin/env node
// Tiny CLI wrapper around startProxy(). Each app's `dev` script runs this (via tsx) to
// spin up the browser↔MCP bridge alongside Vite:
//
//   tsx ../shared/src/proxy-cli.ts
//
// Reads PROXY_PORT / PROXY_TOKEN / WEB_URL / WEB_PORT from the environment and prints the
// connect URL (with ?proxyToken / ?proxyPort) so you can open the app pre-wired to this proxy.
// WEB_PORT lets each app pin its Vite port (see its `dev` script) so the printed URL is correct.

import { startProxy } from "./proxy.js";

const port = Number(process.env.PROXY_PORT ?? 6280);
const webUrl = process.env.WEB_URL ?? `http://localhost:${process.env.WEB_PORT ?? 5173}`;

const proxy = await startProxy({
  port,
  token: process.env.PROXY_TOKEN,
  webUrl,
});

console.log(`\n  ⬡ mcp-query proxy  ${proxy.url}`);
console.log(`  → Open:  ${webUrl}/?proxyToken=${proxy.token}&proxyPort=${port}\n`);

const shutdown = () => { void proxy.close().then(() => process.exit(0)); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
