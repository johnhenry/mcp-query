#!/usr/bin/env node
// mcp-gate CLI: load a config module and serve the governed gate over stdio, so an agent
// host (Claude Desktop, Cursor, …) can spawn the gate in place of the raw upstream.
//
//   mcp-gate ./gate.config.ts
//
// (dev: runs via tsx; a published build would ship dist JS.)

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createGate, type GateConfig } from "./index.js";

export async function run(argv: string[] = process.argv.slice(2)): Promise<void> {
  const path = argv[0];
  if (!path) {
    console.error("usage: mcp-gate <config.{ts,js}>  (config default-exports a GateConfig)");
    process.exit(1);
  }
  const mod = (await import(pathToFileURL(resolve(path)).href)) as { default?: GateConfig; config?: GateConfig };
  const config = mod.default ?? mod.config;
  if (!config) throw new Error(`${path} must default-export a GateConfig`);

  const gate = await createGate(config);
  await gate.server.connect(new StdioServerTransport());
  console.error("[mcp-gate] serving on stdio");

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => void gate.close().then(() => process.exit(0)));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => {
    console.error("[mcp-gate]", e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
