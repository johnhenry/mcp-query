# @mcp-query/cli — `mcp-query`

The unified MCP CLI. One command, three families of verbs:

```
mcp-query <verb> [args] [--json|--raw]
```

| Family       | Verbs                                                               | What it does |
| ------------ | ------------------------------------------------------------------- | ------------ |
| **Tools**    | `codegen` `inspect` `contract` `lint` `docs` `bench` `record` `gate` | Umbrella over the per-tool CLIs (lazy-loaded). |
| **Registry** | `add` `servers`/`ls` `remove`/`rm` `get` `import` `login` `logout`   | A named catalog of MCP servers. |
| **Client**   | `tools` `call` `read` `prompt` `ping` `skills` `skill` `tasks`       | Drive a live server. |

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

### Discovery (Server Cards)

Add a server from its [Server Card](https://modelcontextprotocol.io/seps/2127-mcp-server-cards) or
from a domain's [AI Catalog](https://github.com/Agent-Card/ai-catalog) (`/.well-known/ai-catalog.json`):

```bash
mcp-query add weather --from-card https://example.com/mcp/server-card
mcp-query add --from-domain example.com            # lists entries, adds nothing
mcp-query add --from-domain example.com --pick urn:air:example.com:mcp:weather
mcp-query add weather --from-domain example.com    # a name that matches one entry also selects it
mcp-query card weather                             # fetch <url>/server-card, compare with the live server
mcp-query card weather --from-card <url> --strict  # explicit card URL; non-zero exit on disagreement
```

- Never interactive: with several entries and no `--pick`/matching name it prints the list and exits 1.
- Card contents are untrusted. Only the remote URL is written to the registry; headers the card
  lists (for example a required API key header) are printed, never written. Supply them with
  `--header "K: V"`. Templated URLs need `--var K=V[,K2=V2]`.
- An existing name is not overwritten without `--force`.
- HTTPS only; `--allow-insecure-localhost` permits `http://` for loopback hosts. Cross-origin
  redirects, oversized (> 256 KiB) and wrong-content-type responses are refused.
- `card` needs a remote server; for a stdio server pass `--from-card <url>`. `--no-live` skips the
  live comparison, `--json` prints the card and the findings. The live comparison connects with `--era auto`
  (default; also lets it compare the card's `supportedProtocolVersions` with the server's `server/discover` answer) or
  `--era legacy`; a registry pin applies when the flag is absent.

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

# 2026-07-28 extensions and multi round-trip requests
mcp-query skills docs                                   # skills/list
mcp-query skill  docs skill://pdf-tools/SKILL.md --file references/GUIDE.md   # verified against the manifest
mcp-query tasks get    linear task-1                    # tasks/get
mcp-query tasks cancel linear task-1
mcp-query call linear delete_repo --repo acme/x --answer confirm=true   # answer an input_required round

# Inline (no registration needed)
mcp-query tools --command npx --args "-y @modelcontextprotocol/server-everything"
mcp-query tools --url https://host/mcp --bearer "$TOKEN"
```

`--answer key=value` (repeatable, `call` and `prompt`) answers an `input_required` round without a
prompt: `key` is the request key (`q0`; the value is a JSON object, or `accept` / `decline` / `cancel`,
or a bare value for a one-field form) or the name of a form field. `input_required` exists only on
2026-07-28 connections, so `--answer` needs the default `--era auto` (it is refused with `--era legacy`).
Without `--answer`, a round that asks something prints the pending requests and exits 1. Sampling and
roots requests need a JSON answer.

### `--era`: which handshake

Every verb that connects (`tools` `call` `read` `prompt` `skills` `skill` `tasks` `ping` `session`, and
`--daemon` calls) takes `--era auto|legacy`. The default is **`auto`**: probe `server/discover` first (a
2026-07-28 server answers it, so there is no `initialize`), and fall back to the `initialize` handshake for
anything else. `--era legacy` skips the probe and always uses `initialize`.

What `auto` costs, measured against a 2025-era stdio server on one machine: a stdio server is spawned **one
extra time** for the probe (a short-lived sibling process the SDK starts and discards, never left running),
about 50 ms more per connect (41 ms → 92 ms); a server that never answers the probe costs the probe timeout,
5 s by default (`MCPQ_ERA_PROBE_TIMEOUT_MS` overrides), and is then treated as legacy. On HTTP a probe that
times out is retried once with the legacy handshake. A connection failure (refused, DNS) is reported as it is.

To stop paying that for a server you know is 2025-era, pin it in the registry; the pin applies whenever
`--era` is not given:

```bash
mcp-query add old-server --command node --args ./server.js --era legacy
mcp-query servers          # the era column shows each entry's pin (auto when unset)
```

Pins live in the entry (`"era": "legacy"` in `servers.json` / `.mcp.json`), and the daemon keeps a pinned
connection separate from an `auto` one. `mcp-bench` and `mcp-record` take the same flag with the same default
and honour the pin; so do `mcp-contract` (`snapshot` / `verify` / `diff`), `mcp-docs`, `mcp-lint` and `mcp-query card`'s
live comparison, which capture with `--era auto` by default (`mcp-lint --probe` always negotiates with the bounded
probe). Their contracts record the handshake in `protocol.era`, and a pin made with the other handshake still verifies
without a breaking change (see the [mcp-contract README](../mcp-contract#--era-which-handshake-captures-the-surface)).
`skill` refuses a file that is not in the skill's manifest or whose size/digest differs.
`tasks` on a 2026-07-28 connection needs an SDK that allows `tasks/*` there (>= 2.3.0).

`--json` emits machine-readable output (and, on failure, a
`{ server, tool, issue, message }` object where `issue` is one of
`auth_required` · `offline` · `http_error` · `error`). `--raw` emits the protocol object.

## Tool verbs

The eight tool verbs delegate to their respective package CLIs. As a nicety, the verbs that
don't have their own subcommands (`lint` `docs` `bench` `codegen` `inspect`) accept a bare
server name as their first argument — it's rewritten to `--server <name>`:

```bash
mcp-query lint everything           # ≡  mcp-lint --server everything
mcp-query docs linear               # ≡  mcp-docs --server linear
mcp-query bench everything --runs 50
mcp-query contract capture --server everything   # contract/record keep their subcommands
```

Every flag a tool's own CLI accepts is passed straight through.
