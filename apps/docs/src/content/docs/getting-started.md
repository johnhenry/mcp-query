---
title: "Getting started"
---

The ecosystem has one core package (the reactive client) and seven tools that stack on top of it. This page wires two of them together — the client and a governance gate — so you can see the composition pattern once, then apply it to whichever other pieces you need.

## Install the core client

```sh
npm install mcp-query
```

`mcp-query` gives you a reactive, cached client over any MCP server — TanStack-Query-style document cache, an interceptor chain, and React hooks if you want them.

```ts
import { createClient } from 'mcp-query';

const client = createClient({ server: 'stdio://./my-server' });

const { data, isLoading } = client.useTool('search', { query: 'hello' });
```

## Add a governance layer

Every other package in the ecosystem is a **plugin on the same seam** — an interceptor chain and a transport tap — so adding one is additive, not a rewrite. `@johnhenry/mcp-gate` fronts your server as a policy proxy:

```sh
npm install @johnhenry/mcp-gate
```

```ts
import { createGate } from '@johnhenry/mcp-gate';

const gated = createGate(client, {
  policies: ['./policies/redact-secrets.json'],
  rateLimit: { perMinute: 60 },
});
```

Point your agent host at `gated` instead of `client` and every call now passes through the policy layer — no changes to the calling code.

## Where to go next

- **Authoring an MCP server?** Start with [`@mcp-query/lint`](/packages/lint/) (quality gate) and [`@mcp-query/docs`](/packages/docs-tool/) (generated reference).
- **Consuming one in CI?** [`@mcp-query/contract`](/packages/contract/) catches breaking drift before it ships.
- **Need a fast offline mock?** [`@mcp-query/record`](/packages/record/) captures real traffic and replays it deterministically.
- **Want one command for all of it?** [`@mcp-query/cli`](/packages/cli/) (`mcpq`) wraps every tool above plus a server registry.
- **Curious what it looks like end-to-end?** See [Example apps](/apps/) — seven real UIs built on the client, from a chat composer to a full MCP Inspector.
