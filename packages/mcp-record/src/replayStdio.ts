// Replay over stdio: serve a cassette as a real stdio MCP server (what `mcp-record replay` runs).
//
// A classic (2025-era) cassette is served the classic way: one Server on the stdio transport and the
// `initialize` handshake. A cassette recorded on a 2026-07-28 connection (`protocol.era === "modern"`)
// goes through the SDK's `serveStdio`, which owns the era decision on the opening exchange, so a modern
// client negotiates with `server/discover` and never sees `initialize` (the same behaviour
// `replayTransport` has in process and over HTTP). Node-only (stdio), so it is not part of the
// browser-safe entry; the CLI imports it directly.

import { Server, type Transport } from "@modelcontextprotocol/server";
import { StdioServerTransport, serveStdio } from "@modelcontextprotocol/server/stdio";
import { upgradeCassette, type Cassette, type CassetteV1 } from "./cassette.js";
import { buildReplayServer, createReplayState, replayServer, type ReplayOptions } from "./replay.js";

export interface StdioReplayHandle {
  /** The era the cassette is served as. */
  era: "modern" | "legacy";
  close(): Promise<void>;
}

/** Serve `input` over stdio (or a given server transport). Resolves once it is listening; `close()` ends it. */
export async function replayOverStdio(input: Cassette | CassetteV1, opts: ReplayOptions = {}, transport?: Transport): Promise<StdioReplayHandle> {
  const cassette = upgradeCassette(input);
  if (cassette.protocol?.era === "modern") {
    // One replay cursor for the whole connection: serveStdio may build a throwaway probe instance first.
    const state = createReplayState(cassette, opts);
    const handle = serveStdio((): Server => buildReplayServer(cassette, state), { legacy: "reject", ...(transport ? { transport } : {}) });
    return { era: "modern", close: () => handle.close() };
  }
  const server = replayServer(cassette, opts);
  await server.connect(transport ?? new StdioServerTransport());
  return { era: "legacy", close: () => Promise.resolve(server.close()) };
}
