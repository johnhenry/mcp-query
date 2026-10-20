// Browser-safe subset of mcp-gate (#37). Resolved in place of ./index.ts by bundlers that set
// the `browser` export condition (Vite, webpack, esbuild --platform=browser all do this by
// default for a client build — see the `browser` key under `.` in package.json).
//
// `createGate`/`resolveUpstream` are Node-only (the gateway Server and stdio upstreams) and are
// deliberately NOT re-exported here. The browser-safe library mode is `createGateClient`
// (./client.ts, #65): the full governed interceptor stack over a ConnectionConfig / `{ url }`
// upstream, with no gateway Server. This file must never import ./upstream.ts or
// `@modelcontextprotocol/client/stdio`, even transitively — that's the one import ../index.ts
// (the Node entry) can carry that a browser bundle can't (it pulls in `cross-spawn` and
// `node:stream`). What *is* genuinely useful client-side — e.g. previewing a policy or
// redaction rule set in a config-authoring dashboard before it's deployed to a real gate — is
// pure logic with no such dependency, so it's exported from here unchanged.
//
// Keep this file's import list to modules free of runtime Node-only imports (config, redact,
// validate, client, upstream-http, approval) — the browser test bundles this entry for a
// browser platform and fails if any `node:` builtin or Node-only package sneaks in.

export type { GateConfig, GatePolicy, GatePolicyRules, GateUpstream, StdioUpstreamSpec, HttpUpstreamSpec } from "./config.js";
export type { RedactRule } from "./redact.js";
export { redact, redactValue } from "./redact.js";
export { compilePolicy, policyListAnnotator, policyListFilter } from "./config.js";
export { validateGateConfig } from "./validate.js";
export { createGateClient } from "./client.js";
export type { GateClient } from "./client.js";
export { resolveHttpUpstream } from "./upstream-http.js";
export type { ApprovalConfig, ApprovalRequest } from "./config.js";
export { CircuitOpenError } from "@johnhenry/mcp-query/server";
