---
"@johnhenry/mcp-record": minor
---

`mcp-record replay` (stdio) now serves a 2026-07-28 cassette to a modern client with `server/discover` and no `initialize` (it previously served only the classic handshake); a 2025-era cassette is served as before. `mcp-record record --call` can answer `input_required` rounds with a repeatable `--answer key=value` (every round is recorded as its own interaction) and fails clearly without one instead of writing a half cassette. `record --era` now defaults to `auto` (a bounded `server/discover` probe, then `initialize`; a failed `auto` connect is retried once as `legacy`), so a server that speaks 2026-07-28 is recorded as a modern cassette, and a registry entry's `era` pin applies. Use `--era legacy` for the old behaviour. README: documents `--redact`, `--era`, `--answer` and the `tool(a: 1)` call form.
