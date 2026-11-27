---
"@johnhenry/mcp-query": minor
---

Add `@johnhenry/mcp-query/discovery`: Zod schemas for MCP Server Cards (SEP-2127) and the AI Catalog envelope, `fetchServerCard(url, opts)`, `discoverFromDomain(domain, opts)` (reads `/.well-known/ai-catalog.json`), remote URL resolution, and `compareCardToLive` to flag disagreement with a live server. Fetches are HTTPS-only (loopback http behind an explicit option), size-capped, time-limited, refuse cross-origin redirects, check the content type and accept an injectable `fetch`; results are untrusted display data and nothing is registered or connected.
