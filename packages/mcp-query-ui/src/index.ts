// @johnhenry/mcp-query-ui — MCP Apps (SEP-1865) host for @johnhenry/mcp-query.
export { createAppHost, mcpAppsExtensions, MCP_APPS_EXTENSION_ID } from "./host.js";
export type { AppHost, AppSession, OpenAppOptions } from "./host.js";
export { mountIframe, SANDBOX_PROXY_SANDBOX } from "./iframe.js";
export type { MountIframeOptions, MountedIframe } from "./iframe.js";
export { buildAppCsp, sanitizeCsp, isSafeCspSource } from "./csp.js";
export type { CspDomainKind } from "./csp.js";
export type { AppCall, AppHostOptions, AppMessage, AppResource, AppSessionState, AppStatus } from "./types.js";
