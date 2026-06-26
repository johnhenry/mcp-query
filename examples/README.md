# Examples — granular → complex

A progression: each step adds one capability, then they combine. The numbered `.ts`
examples are **runnable** with no network (they use the in-memory mock server) — run any
with `npx tsx examples/<file>`. The `.tsx` files are **illustrative** (compile under
`tsc`, need a bundler + DOM to run).

| # | File | Adds | Run |
|---|------|------|-----|
| 01 | [`01-minimal.ts`](./01-minimal.ts) | connect → list → call one tool | `npx tsx examples/01-minimal.ts` |
| 02 | [`02-cache-and-invalidation.ts`](./02-cache-and-invalidation.ts) | cached + de-duped reads; tag invalidation after a mutation | `npx tsx examples/02-cache-and-invalidation.ts` |
| 03 | [`03-live-subscriptions.ts`](./03-live-subscriptions.ts) | `resources/subscribe` → push-driven cache invalidation | `npx tsx examples/03-live-subscriptions.ts` |
| 04 | [`04-multi-server.ts`](./04-multi-server.ts) | multiplexing: namespace + scheme routing, isolated failure | `npx tsx examples/04-multi-server.ts` |
| 05 | [`05-human-in-the-loop.ts`](./05-human-in-the-loop.ts) | a tool that elicits + samples, driven through the broker | `npx tsx examples/05-human-in-the-loop.ts` |
| 06 | [`06-alongside-another-client.ts`](./06-alongside-another-client.ts) | **mcp-query beside a separate MCP client on shared state** | `npx tsx examples/06-alongside-another-client.ts` |
| — | [`node-everything.ts`](./node-everything.ts) | guided tour against the **real** `server-everything` (+ codegen) | `npm run example:node` |
| 07 | [`07-hybrid-agent-ui.tsx`](./07-hybrid-agent-ui.tsx) | *illustrative*: LLM agent + live mcp-query UI + broker, one app | bundler |
| — | [`react-app.tsx`](./react-app.tsx) | *illustrative*: every React surface wired together | bundler |

## Working alongside other clients

mcp-query is a **non-agentic data layer**, not a replacement for your agent or other MCP
clients — it's designed to run *beside* them:

- **06 (runnable)** connects mcp-query and a raw `@modelcontextprotocol/sdk` `Client`
  (standing in for an LLM agent / Claude Desktop / Vercel AI SDK / LangChain) to one
  stateful server. The other client *acts* (calls tools); mcp-query's cache stays live via
  the server's `resources/updated` pushes. The two clients never know about each other —
  the MCP protocol is the only contract.
- **07 (illustrative)** puts both in the *same app and the same `MCPClient`*: an LLM agent
  chooses and calls tools while mcp-query renders the live read view over the same servers,
  and the `InteractionBroker` routes the agent's sampling/elicitation through human
  approval. The "non-agentic UI + agentic actions" hybrid.

The takeaway: adopt mcp-query for the reactive read/cache/UI/approval layer without giving
up whatever you already use to drive the LLM.
