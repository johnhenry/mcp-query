# mcp-lint

**ESLint for MCP servers.** Quality-lint a server's capability surface against a set of
design rules — descriptions, annotations, typed inputs, naming — and gate CI on the result.

It's the complement to [`@mcp-query/contract`](../mcp-contract): contract checks *drift*
between two versions (*"did it change incompatibly?"*); lint checks *quality* of one
version (*"is this surface well-designed?"*). Both run on the same captured surface.

## Use

```bash
# lint a live server
npx tsx packages/mcp-lint/src/cli.ts \
  --command npx --args "-y @modelcontextprotocol/server-everything"

# …or a pinned contract (mcp-contract snapshot), and be strict in CI
npx tsx packages/mcp-lint/src/cli.ts --contract mcp.contract.json --max-warnings 0

npx tsx packages/mcp-lint/src/cli.ts --list-rules
```

Exits non-zero on any **error**-level finding, or when warnings exceed `--max-warnings`
(default: unbounded). Disable or escalate rules with `--off a,b` / `--error a,b`.

Example output against `@modelcontextprotocol/server-everything`:

```
  warn   get-env  name implies a read-only action but readOnlyHint is not set  (read-only-annotation)
  warn   get-resource-reference  input "resourceType" has no description  (tool-input-described)
  ~ 0 errors, 9 warnings
```

## Rules

| Rule | Default | Checks |
|---|---|---|
| `tool-description` | **error** | every tool has a non-empty description |
| `tool-input-described` | warn | every tool input property has a description |
| `destructive-annotation` | warn | a `delete`/`remove`/… -named tool sets `destructiveHint` |
| `read-only-annotation` | warn | a `get`/`list`/`read`/… -named tool sets `readOnlyHint` |
| `no-open-input` | warn | input schema isn't `additionalProperties: true` (untyped) |
| `resource-mime-type` | warn | resources declare a `mimeType` |
| `prompt-description` | warn | prompts have a description |
| `naming-consistency` | warn | tool names use a single convention (no kebab+snake mix) |

The annotation rules are heuristic (they match verb segments in names), so they're warnings
you can silence per-rule when a name is a false positive.

## Programmatic API

```ts
import { lintContract, formatLint, RULES } from "@mcp-query/lint";
import { captureContract } from "@mcp-query/contract";

const contract = await captureContract(connectedSdkClient);
const result = lintContract(contract, { rules: { "naming-consistency": "off" } });
if (result.errors) throw new Error(formatLint(result));
```

`lintContract(contract, opts)` returns `{ findings, errors, warnings }`. Findings carry
`{ rule, severity, target, message }`. Pass `opts.rules` to override any rule's severity.

## Family

| Project | Role |
|---|---|
| mcp-query | consume MCP |
| mcp-gate | govern at runtime |
| mcp-contract | guard the interface in CI (drift) |
| **mcp-lint** | **lint surface quality in CI** |
| mcp-record | freeze real traffic as fixtures |

## Tests

```bash
npx vitest run   # each rule + severity overrides + a clean-surface baseline
```

## Status

MVP (`private: true`). Roadmap: per-rule config file, autofix suggestions, JSON output,
and a GitHub Action.
