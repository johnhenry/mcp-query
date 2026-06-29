# @mcp-query/socialgpt-studio

A creator-analytics UI built on **[mcp-query](../../packages/mcp-query)** over the LIVE,
OAuth-protected **SocialGPT** MCP server at `https://mcp.gpt.social/mcp` (server name
`SocialGPT`, 21 tools).

React + Vite frontend, a small **Deno** backend (with a plain-**Node** fallback) that
reverse-proxies `/mcp` to the live server and injects the OAuth bearer token.

---

## Architecture

```
 React app  ──fetch("/mcp")──▶  reverse proxy (:8787)  ──Bearer token──▶  mcp.gpt.social/mcp
 (StreamableHTTPClientTransport)   Deno  backend/main.ts          (refresh-on-401, retry once)
                                or Node  backend/node-proxy.mjs
   dev: Vite server.proxy /mcp ─▶ :8787
```

- The React app **always** calls the relative URL `/mcp` — it never sees the token.
- The client is built **directly** (no WS proxy / `makeProxyClient`):

  ```ts
  const client = new MCPClient({
    servers: { socialgpt: { transport: () => new StreamableHTTPClientTransport(new URL("/mcp", location.origin)) } },
    clientInfo: { name: "socialgpt-studio", version: "0.0.1" },
  });
  void client.connect();
  ```

- The proxy reads `~/.mcp-query/oauth/mcp.gpt.social.json`
  (`{ clientInformation: { client_id, … }, tokens: { access_token, refresh_token, … } }`),
  injects `Authorization: Bearer <access_token>`, and on a `401` refreshes the token
  (`POST https://mcp.gpt.social/oauth/token`, `grant_type=refresh_token`), persists the
  new tokens back to that file, and retries the request once. Responses are streamed
  through unbuffered (the server replies `text/event-stream`).

---

## Login (self-contained)

The app **facilitates its own login** — no CLI step needed. On launch it checks
`/auth/status`; if you're not signed in it shows a **Connect SocialGPT** screen. Clicking it
runs the full OAuth 2.1 flow from the backend (dynamic client registration + PKCE), opens
your system browser to SocialGPT's sign-in page, captures the redirect on
`http://localhost:8787/auth/callback`, exchanges the code, and caches the token at
`~/.mcp-query/oauth/mcp.gpt.social.json`. The UI polls `/auth/status` and proceeds once done.

This is exactly why a **desktop** app is the right home for it: the backend, the OAuth
callback, and your browser are all on the same machine, so login needs **no SSH tunnel** (the
remote-server caveat that applies to the `mcp-contract auth` CLI). Sign-in happens on
SocialGPT's own page — the app never sees your password.

Backend auth routes: `GET /auth/status`, `POST /auth/login` (→ `{ authorizeUrl }`),
`GET /auth/callback`, `POST /auth/logout`. An existing token (e.g. from `mcp-contract auth`)
is reused and auto-refreshed; if it carries only `analysis:read`, the app shows a
**"Reconnect for full access"** banner that re-runs login requesting `analysis:read:public`
too (some tools like `get_creator` need it).

---

## Run (dev)

Two processes — the proxy and Vite:

```bash
# Terminal 1 — the reverse proxy on :8787
#   Deno (preferred):
deno task dev                 # = deno run -A backend/main.ts
#   …or plain Node (no Deno required):
node backend/node-proxy.mjs

# Terminal 2 — the Vite dev server (proxies /mcp → :8787)
npm run dev -w @mcp-query/socialgpt-studio
```

Open the URL Vite prints (default http://localhost:5173). Vite's `server.proxy` forwards
`/mcp` to `http://localhost:8787`.

> No Deno installed? Use `node backend/node-proxy.mjs` — it's a byte-for-byte equivalent
> of the Deno proxy (same token read / refresh-on-401 / retry logic).

## Run (production / single process)

```bash
npm run build -w @mcp-query/socialgpt-studio   # → dist/
deno run -A backend/main.ts                    # serves dist/ AND proxies /mcp on :8787
#   …or: node backend/node-proxy.mjs
```

Then open http://localhost:8787 — the backend serves the built SPA and proxies `/mcp`.

---

## Desktop packaging (experimental)

`deno task desktop` runs:

```bash
deno run -A scripts/embed-dist.ts && deno desktop -A --no-check --output SocialGPT.app backend/main.ts
```

Requires **Deno ≥ 2.9** (the subcommand is experimental). Three hard-won details, all handled
by the task:

1. **The SPA is embedded as a static JSON module, not via `--include`.** `scripts/embed-dist.ts`
   writes `backend/dist-embed.json` (`{ path: base64 }` for every file in `dist/`); `backend/main.ts`
   imports it statically, so `deno compile` follows it and ships `dist/` *inside* the binary —
   then serves from it (filesystem `dist/` is the dev fallback). We learned this the hard way:
   `deno desktop --include dist` **breaks entry resolution on macOS** (`Module not found …/backend/main.ts`
   / `TS2307`), and *without* embedding, the window loads but shows `not found (build the app first)`.
   The static-import approach needs neither flag and works cross-platform. **Build `dist/` first**
   (`npm run build`) so there's something to embed.
2. **Permissions must be baked in** — unlike `deno task dev` (`deno run -A`), a *compiled* binary
   only has the permissions passed at compile time. `backend/main.ts` reads `HOME` + the token
   cache, writes refreshed tokens, serves + fetches, and opens the system browser → `env + read +
   write + net + run`. `-A` is simplest. Without it the `.app` fails at launch with
   `Requires env access to "HOME", specify … --allow-env`.
3. **`--no-check`** — `deno desktop` type-checks the entry by default and can spuriously fail
   (`TS2307`, environment-dependent). The app is already type-checked by `npm run typecheck` (tsc).

```bash
npm run build -w @mcp-query/socialgpt-studio   # 1. build the SPA → dist/
cd apps/socialgpt-studio
deno task desktop                              # 2. embed dist + compile → SocialGPT.app
open SocialGPT.app                             # 3. run it
```

**Use `deno task desktop`, not bare `deno desktop`** — this app is a Vite SPA *plus* a Deno
backend (the `/mcp` reverse-proxy + `/auth` OAuth login); the task points at `backend/main.ts`
so both ship. Bare `deno desktop` would bundle only the static SPA and `/mcp` + `/auth` would 404.

**Reliable fallback** (works on any Deno, no packaging): `deno run -A backend/main.ts` (or
`node backend/node-proxy.mjs`) then open `http://localhost:8787` — the identical app, login included.

---

## Screens

| Screen | Tools used | Notes |
|--------|-----------|-------|
| **Search** | `list_accounts`, `search`, `search_videos` (`useToolResult`) | Tabs: Accounts / Search / Videos. Cards drill into Creator or Video. **No auto-refetch** (cached). |
| **Creator** | `get_creator`, `get_account_metrics`, `get_follower_history`, `get_growth_summary`, `list_creator_videos` | Keyed by `(platform, username)` / `account_id`. Follower history & growth render as a **hand-rolled inline SVG line chart** (no chart lib). |
| **Analyze** | `analyze_creator` / `analyze_post` (`useTool` mutation) → poll `get_analysis_status` (`useToolResult` `refetchInterval`) | Polls **only while pending**; stops on done/error. Surfaces a **10 calls/hour** budget meter. |
| **Video** | `get_video`, `get_video_analysis` | Pending → retry poll pattern (poll only while unsettled). |
| **Header** | `whoami`, `server_info`, `useServerState` | Connection state + identity + analysis budget. |

### Rate-limit awareness

The analysis tools are limited to **10 calls/hour**. The app tracks spent calls in
`localStorage` (rolling 1h window, see `src/lib/rateBudget.ts`), shows a remaining-budget
pill in the header and Analyze screen, and disables the Analyze form when the budget is
exhausted. Read screens are cached and **never auto-refetch**, to avoid burning quota.

> Note: the supplied token carries the `analysis:read` scope. Some tools (e.g.
> `get_creator`) require `analysis:read:public`; if the token lacks a scope the server
> returns a tool error, which the UI surfaces in an error state. `whoami` /
> `server_info` / `list_accounts` work with the base scope.

---

## Tests

```bash
npm test -w @mcp-query/socialgpt-studio
```

- `test/analysis.test.ts` — unit tests for the **analysis polling state machine**
  (`reduceAnalysis`: pending → done / error, progress normalization, MCP-result
  unwrapping) and the result formatters (`asList`, `asSeries`, `displayName`).
- `test/integration.test.tsx` — a real `MCPClient` over `InMemoryTransport` wired to a
  `MockMCPServer` (`mcp-query/testing`) emulating SocialGPT's `search` and
  `get_follower_history` tools; renders components via `@testing-library/react`
  (happy-dom) and asserts the search list + the SVG follower chart render their data.

---

## Verify

```bash
npm run typecheck -w @mcp-query/socialgpt-studio
npm test       -w @mcp-query/socialgpt-studio
npm run build  -w @mcp-query/socialgpt-studio
deno check backend/main.ts          # best-effort (needs Deno)
node --check backend/node-proxy.mjs
```

**Live target:** `https://mcp.gpt.social/mcp` (via the local reverse proxy on :8787).
