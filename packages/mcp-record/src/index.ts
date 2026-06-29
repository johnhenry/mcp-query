// mcp-record — record real MCP traffic to a cassette, replay it offline as a
// deterministic mock. VCR/Polly/nock for MCP. Records via mcp-query's transport seam;
// replays as a real SDK Server. Pairs with mcp-contract (shape) — this is real fixtures.

export { createCassette, interactionKey, type Cassette, type Interaction } from "./cassette.js";
export { recordTransport } from "./record.js";
export { replayServer, replayTransport } from "./replay.js";
