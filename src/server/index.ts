// Server-side / backend building blocks for mcp-query. Optional, tree-shakeable —
// import from `mcp-query/server`.

export { authorize, denyDestructiveUnless, AuthorizationError } from "./authorize.js";
export type { AuthzVerdict, AuthzRequest } from "./authorize.js";
