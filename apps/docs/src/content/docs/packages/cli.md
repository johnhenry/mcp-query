---
title: "@mcp-query/cli — `mcp-query`"
---

The unified MCP CLI. One command, three families of verbs:

```
mcp-query <verb> [args] [--json|--raw]
```

| Family       | Verbs                                                               | What it does |
| ------------ | ------------------------------------------------------------------- | ------------ |
| **Tools**    | `codegen` `inspect` `contract` `lint` `docs` `bench` `record` `gate` | Umbrella over the per-tool CLIs (lazy-loaded). |
| **Registry** | `add` `servers`/`ls` `remove`/`rm` `get` `import` `login` `logout`   | A named catalog of MCP servers. |
| **Client**   | `tools` `call` `read` `prompt` `ping`                                | Drive a live server. |

`mcp-query help` (or `--help`) prints the grouped verb list.

## The registry

Servers live in a catalog using the de-facto `.mcp.json` / `mcpServers` standard shared by
Claude, Cursor, and VS Code — so existing configs work as-is. Resolution merges
**project `.mcp.json`** over **user `~/.mcp-query/servers.json`** (project wins). OAuth tokens
are **not** stored in the registry; they live in the `~/.mcp-query/oauth/` cache (see `login`).

```bash
# Register a hosted (http/sse) server, or a local stdio one
mcp-query add linear https://mcp.linear.app/sse --description "Linear MCP"
mcp-query add everything --command npx --args "-y @modelcontextprotocol/server-everything"
mcp-query add github https://api.githubcopilot.com/mcp --header "Authorization: Bearer $TOKEN"

mcp-query servers              # aligned table  (alias: mcp-query ls)
mcp-query servers --json
mcp-query get linear --json
mcp-query remove linear        #               (alias: mcp-query rm)

# Pull servers in from another tool's config
mcp-query import claude        # or cursor | vscode | ./some/path.json

# Browser OAuth for a hosted server (cached for later verbs)
mcp-query login linear
mcp-query logout linear
```

Once registered, **every** verb accepts the server's **name** wherever it accepts a URL — and
the tool verbs gain it too via `--server <name>`.

## Client verbs

A server reference is a **registered name**, a **URL**, or **inline flags**
(`--command/--args` · `--url` · `--bearer` · `--header "K: V"`).

```bash
mcp-query tools linear                 # list tools as `name(arg: type, …)` signatures
mcp-query tools linear --json          # names + descriptions, as JSON
mcp-query tools linear --schema        # full inputSchema for each tool
mcp-query tools linear --resources     # resources instead of tools
mcp-query tools linear --prompts       # prompts instead of tools

# Call a tool — flag style …
mcp-query call linear create_issue --title "Bug" team=ENG
# … or a function-call string (values coerced by the tool's inputSchema)
mcp-query call linear 'create_issue(title: "Bug", team: "ENG")'
mcp-query call linear delete_issue --id ISSUE-1 --yes   # --yes skips destructive confirm

mcp-query read  linear "linear://issues/ISSUE-1"
mcp-query prompt linear standup --team ENG
mcp-query ping  linear

# Inline (no registration needed)
mcp-query tools --command npx --args "-y @modelcontextprotocol/server-everything"
mcp-query tools --url https://host/mcp --bearer "$TOKEN"
```

`--json` emits machine-readable output (and, on failure, a
`{ server, tool, issue, message }` object where `issue` is one of
`auth_required` · `offline` · `http_error` · `error`). `--raw` emits the protocol object.

## Tool verbs

The eight tool verbs delegate to their respective package CLIs. Verbs without their own
subcommands (`lint` `docs` `bench` `codegen` `inspect`) accept a bare server name as their
first argument — it's rewritten to `--server <name>`. `contract` and `record` keep their
subcommands, and a registered name **after** the subcommand resolves too (the rewrite is
resolution-gated, so file positionals like `record inspect tape.json` are never mangled):

```bash
mcp-query lint everything                 # ≡  mcp-lint --server everything
mcp-query docs linear                     # ≡  mcp-docs --server linear
mcp-query bench everything --iterations 50
mcp-query contract snapshot everything --out pin.json
mcp-query record record everything --out tape.json
mcp-query bench --help                    # per-verb usage at the umbrella
```

Every flag a tool's own CLI accepts is passed straight through — and **unknown flags are
rejected** with the list of known flags (typos fail fast instead of being silently
swallowed). The client verbs `call`/`prompt` are exempt by design: unknown flags there
*are* the tool arguments. One call grammar works everywhere a call is specified —
`mcp-query call`, `bench --call`, and `record --call` all accept both
`tool(k: v, …)` and `tool:{"k":"v"}`.
