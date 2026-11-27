---
"@johnhenry/mcp-query": minor
---

Skills over MCP (`io.modelcontextprotocol/skills`, SEP-2640): `connection.supports("skills")`, `client.listSkills(server?)`, `client.getSkill(uri, server)` and `client.readSkillFile(skill, ref?)` built on the SDK's `SkillsClient`, so size, digest and frontmatter verification is the SDK's and failures surface as `MCPError` with the reason preserved (`skillVerificationReason`). Listings honor SEP-2549 `ttlMs`/`cacheScope`, are keyed per server and `client.scope()` partition, go stale on `resources/list_changed`, and verified files are cached by manifest digest. Adds `useSkills` / `useSkill` and a `MockMCPServer` `skills` fixture (including tampered-digest/size/frontmatter cases). Needs `@modelcontextprotocol/client` >= 2.4.0 at call time; the peer range is unchanged and older SDKs get a clear `MCPError` naming the minimum version.
