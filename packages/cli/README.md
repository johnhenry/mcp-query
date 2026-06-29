# @mcp-query/cli — `mcpq`

The unified MCP CLI. One command, three families of verbs:

```
mcpq <verb> [args] [--json|--raw]
```

| Family       | Verbs                                                               | What it does |
| ------------ | ------------------------------------------------------------------- | ------------ |
| **Tools**    | `codegen` `inspect` `contract` `lint` `docs` `bench` `record` `gate` | Umbrella over the per-tool CLIs (lazy-loaded). |
| **Registry** | `add` `servers`/`ls` `remove`/`rm` `get` `import` `login` `logout`   | A named catalog of MCP servers. |
| **Client**   | `tools` `call` `read` `prompt` `ping`                                | Drive a live server. |

`mcpq help` (or `--help`) prints the grouped verb list.

## The registry

Servers live in a catalog using the de-facto `.mcp.json` / `mcpServers` standard shared by
Claude, Cursor, and VS Code — so existing configs work as-is. Resolution merges
**project `.mcp.json`** over **user `~/.mcp-query/servers.json`** (project wins). OAuth tokens
are **not** stored in the registry; they live in the `~/.mcp-query/oauth/` cache (see `login`).

```bash
# Register a hosted (http/sse) server, or a local stdio one
mcpq add linear https://mcp.linear.app/sse --description "Linear MCP"
mcpq add everything --command npx --args "-y @modelcontextprotocol/server-everything"
mcpq add github https://api.githubcopilot.com/mcp --header "Authorization: Bearer $TOKEN"

mcpq servers              # aligned table  (alias: mcpq ls)
mcpq servers --json
mcpq get linear --json
mcpq remove linear        #               (alias: mcpq rm)

# Pull servers in from another tool's config
mcpq import claude        # or cursor | vscode | ./some/path.json

# Browser OAuth for a hosted server (cached for later verbs)
mcpq login linear
mcpq logout linear
```

Once registered, **every** verb accepts the server's **name** wherever it accepts a URL — and
the tool verbs gain it too via `--server <name>`.

## Client verbs

A server reference is a **registered name**, a **URL**, or **inline flags**
(`--command/--args` · `--url` · `--bearer` · `--header "K: V"`).

```bash
mcpq tools linear                 # list tools as `name(arg: type, …)` signatures
mcpq tools linear --json          # names + descriptions, as JSON
mcpq tools linear --schema        # full inputSchema for each tool
mcpq tools linear --resources     # resources instead of tools
mcpq tools linear --prompts       # prompts instead of tools

# Call a tool — flag style …
mcpq call linear create_issue --title "Bug" team=ENG
# … or a function-call string (values coerced by the tool's inputSchema)
mcpq call linear 'create_issue(title: "Bug", team: "ENG")'
mcpq call linear delete_issue --id ISSUE-1 --yes   # --yes skips destructive confirm

mcpq read  linear "linear://issues/ISSUE-1"
mcpq prompt linear standup --team ENG
mcpq ping  linear

# Inline (no registration needed)
mcpq tools --command npx --args "-y @modelcontextprotocol/server-everything"
mcpq tools --url https://host/mcp --bearer "$TOKEN"
```

`--json` emits machine-readable output (and, on failure, a
`{ server, tool, issue, message }` object where `issue` is one of
`auth_required` · `offline` · `http_error` · `error`). `--raw` emits the protocol object.

## Tool verbs

The eight tool verbs delegate to their respective package CLIs. As a nicety, the verbs that
don't have their own subcommands (`lint` `docs` `bench` `codegen` `inspect`) accept a bare
server name as their first argument — it's rewritten to `--server <name>`:

```bash
mcpq lint everything           # ≡  mcp-lint --server everything
mcpq docs linear               # ≡  mcp-docs --server linear
mcpq bench everything --runs 50
mcpq contract capture --server everything   # contract/record keep their subcommands
```

Every flag a tool's own CLI accepts is passed straight through.
