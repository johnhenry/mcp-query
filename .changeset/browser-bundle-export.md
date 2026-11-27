---
"@johnhenry/mcp-query": minor
---

Add a `@johnhenry/mcp-query/browser-bundle` export: one self-contained, minified ESM file (`dist/browser/mcp-query.browser.js`) with the MCP SDK client, zod and agent-query-core inlined, plus the browser-safe parts of `@johnhenry/mcp-gate` (`createGateClient`, policy and redaction helpers). One import in a browser makes no further requests, so hosts can pin and vendor it. React hooks stay out of the bundle. Existing export paths are unchanged. The README has a size table (`npm run size-table`).
