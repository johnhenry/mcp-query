// mcp-record — record real MCP traffic to a cassette, replay it offline as a
// deterministic mock. VCR/Polly/nock for MCP. Records via mcp-query's transport seam;
// replays as a real SDK Server. Pairs with mcp-contract (shape) — this is real fixtures.

export {
  createCassette,
  interactionKey,
  scrubFileBytes,
  cassetteHash,
  sealCassette,
  loadCassette,
  upgradeCassette,
  tagInteraction,
  CASSETTE_VERSION,
  type Cassette,
  type Interaction,
  type InteractionKind,
  type CassetteV1,
  type CassetteProtocol,
} from "./cassette.js";
export { recordTransport, redactPaths, type RecordOptions } from "./record.js";
export { replayServer, replayTransport, type ReplayOptions } from "./replay.js";
