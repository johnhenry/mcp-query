---
"@johnhenry/mcp-query": patch
---

Fix `mcp-query-inspect` and `mcp-query-codegen` doing nothing when run from an install. Both checked whether they were the entry script by comparing `import.meta.url` with `process.argv[1]` as strings; an installed bin is a symlink, so the check never matched and the command exited 0 with no output. They now compare real paths, as the `mcp-gate`, `mcp-contract` and `mcp-record` CLIs already do.
