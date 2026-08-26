// 03 · Record & replay — mcp-record taping a live session, then replaying it as
// a deterministic offline server. Both sides of the tape are driven by the SAME
// mcp-query MCPClient surface: recordTransport wraps the mock's transport on the
// way in, replayTransport IS a ConnectionConfig transport factory on the way out.
// Run: npm run example:03   (from the repo root; `npm run build` first)

import { MCPClient } from "@johnhenry/mcp-query";
import { MockMCPServer } from "@johnhenry/mcp-query/testing";
import { createCassette, recordTransport, replayTransport } from "../packages/mcp-record/src/index.js";

const live = new MockMCPServer({
  tools: [{ name: "quote", handler: () => ({ content: [{ type: "text", text: `price: ${(Math.random() * 100).toFixed(2)}` }] }) }],
});

// ── record ── tap the transport; use the client normally.
const cassette = createCassette();
const rec = new MCPClient({ servers: { fin: { transport: () => recordTransport(live.transport(), cassette) } } });
await rec.connect();
const taped = (await rec.callTool("fin.quote", {})) as { content: { text: string }[] };
console.log("live result (random):", taped.content[0]?.text);
await rec.close();
await live.close(); // the live server is GONE from here on

console.log("cassette:", cassette.interactions.length, "interactions from", cassette.recordedFrom?.name);

// ── replay ── same client code, no mock, no network: the cassette answers.
const replay = new MCPClient({ servers: { fin: { transport: replayTransport(cassette) } } });
await replay.connect();
const replayed = (await replay.callTool("fin.quote", {})) as { content: { text: string }[] };
console.log("replayed result:      ", replayed.content[0]?.text);
console.log("identical to the recording:", replayed.content[0]?.text === taped.content[0]?.text); // true — frozen, not re-random
await replay.close();
