# mcp-docs

**Generate Markdown reference docs from an MCP server's capability surface.** Redoc for MCP.

Point it at a live server (or a pinned [contract](../mcp-contract)) and it renders a clean
reference: tools with annotation badges and an arguments table per input schema, resources,
resource templates, and prompts.

## Use

```bash
# from a live server
npx tsx packages/mcp-docs/src/cli.ts \
  --command npx --args "-y @modelcontextprotocol/server-everything" \
  --out API.md

# …or from a pinned contract, with a custom title
npx tsx packages/mcp-docs/src/cli.ts --contract mcp.contract.json --title "My Server" > API.md
```

With no `--out`, the Markdown is written to stdout (pipe it anywhere). See
[`examples/everything.md`](examples/everything.md) for real generated output.

## What it renders

```markdown
# mcp-servers/everything v2.0.0

> 13 tools · 7 resources · 2 templates · 4 prompts

## Tools

### `get-annotated-message`

Demonstrates how annotations can be used to provide metadata about content.

| Argument | Type | Required | Description |
| --- | --- | :---: | --- |
| `messageType` | "error" \| "success" \| "debug" | ✔ | Type of message … |
| `includeImage` | boolean |  | Whether to include an example image |
```

- **Tools** — heading per tool with `read-only` / `destructive` / `idempotent` badges from
  annotations, the description, and an args table derived from the input JSON Schema
  (scalars, arrays as `T[]`, enums as `"a" \| "b"`); a **Returns:** line when an
  `outputSchema` is present, and *No arguments.* when there are none.
- **Resources / templates** — tables of URI, name, MIME type.
- **Prompts** — heading per prompt with its description and an argument table.

## Programmatic API

```ts
import { renderMarkdown, schemaType } from "@mcp-query/docs";
import { captureContract } from "@mcp-query/contract";

const contract = await captureContract(connectedSdkClient);
await writeFile("API.md", renderMarkdown(contract, { title: "My Server" }));
```

`renderMarkdown(contract, opts?)` is a pure function — drop it into a build step, a docs
site, or a PR check that commits the generated reference.

## Family

| Project | Role |
|---|---|
| mcp-query | consume MCP |
| mcp-gate | govern at runtime |
| mcp-contract | guard the interface in CI (drift) |
| mcp-lint | lint surface quality in CI |
| **mcp-docs** | **generate reference docs from a surface** |
| mcp-record | freeze real traffic as fixtures |

## Tests

```bash
npx vitest run   # schemaType rendering + full-document structure
```

## Status

MVP (`private: true`). Roadmap: HTML output, grouping/sections, `$ref` resolution, and a
`--check` mode that fails when committed docs are stale.
