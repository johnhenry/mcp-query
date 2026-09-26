// Browser-safe subset of mcp-gate (#37). Resolved in place of ./index.ts by bundlers that set
// the `browser` export condition (Vite, webpack, esbuild --platform=browser all do this by
// default for a client build — see the `browser` key under `.` in package.json).
//
// `createGate`/`resolveUpstream` are Node-only by nature (they spawn/connect an actual
// upstream MCP server process — meaningless in a browser tab) and are deliberately NOT
// re-exported here, and this file must never import ./upstream.ts or
// `@modelcontextprotocol/client/stdio`, even transitively — that's the one import ../index.ts
// (the Node entry) can carry that a browser bundle can't (it pulls in `cross-spawn` and
// `node:stream`). What *is* genuinely useful client-side — e.g. previewing a policy or
// redaction rule set in a config-authoring dashboard before it's deployed to a real gate — is
// pure logic with no such dependency, so it's exported from here unchanged.
//
// Keep this file's own import list to ./config.js and ./redact.js only, and keep both of
// those free of runtime Node-only imports — that invariant is what makes this entry safe.

export type { GateConfig, GatePolicy, GatePolicyRules, GateUpstream, StdioUpstreamSpec, HttpUpstreamSpec } from "./config.js";
export type { RedactRule } from "./redact.js";
export { redact } from "./redact.js";
export { compilePolicy, policyListFilter } from "./config.js";
export { validateGateConfig } from "./validate.js";
