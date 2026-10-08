# @johnhenry/mcp-query-ui

An **MCP Apps host** for [`@johnhenry/mcp-query`](../mcp-query). MCP Apps
([SEP-1865](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx),
extension id `io.modelcontextprotocol/ui`, stable 2026-01-26) let an MCP server ship an interactive
HTML UI as a `ui://` resource. This package mounts such an app in a sandboxed iframe using the
official [`@modelcontextprotocol/ext-apps`](https://github.com/modelcontextprotocol/ext-apps) host
helpers (`AppBridge`), as a **thin reactive layer** over the `MCPClient` you already have:

- the app's `tools/call` and `resources/read` are executed **by your `MCPClient`**, so the cache,
  every interceptor, and **[`mcp-gate`](../mcp-gate) policy / approval / audit apply** to app-initiated
  traffic exactly as they do to an agent's. The app is not a side channel;
- the app's lifecycle, `ui/message`s and calls are **subscribable state**
  (`subscribe` / `getState`, `useSyncExternalStore`-compatible, like mcp-query's cache entries);
- one `ext-apps` dependency, only here: `@johnhenry/mcp-query` itself is unchanged apart from an
  opt-in `extensions` option for capability negotiation.

> **Sequencing.** This is the UI slice. Per the family plan it comes before the
> `a2a-query -> acp-query -> AP2` line; an AP2 extension module will build on the same
> "app traffic goes through the client" rule later. Nothing here depends on it.

```bash
npm install @johnhenry/mcp-query-ui @johnhenry/mcp-query @modelcontextprotocol/client
# React adapter is optional: react ^18 || ^19
```

## Quick start

```ts
import { MCPClient } from "@johnhenry/mcp-query";
import { createAppHost, mcpAppsExtensions, mountIframe } from "@johnhenry/mcp-query-ui";

const client = new MCPClient({
  servers: { dash: { transport: () => /* ... */ } },
  extensions: mcpAppsExtensions(),          // tell servers we can render MCP Apps (io.modelcontextprotocol/ui)
  // interceptors: [authorize(...)]          // or point the host at an mcp-gate's `gate.client`
});
await client.connect();

const host = createAppHost({ client, server: "dash" });

// Resolve the app from a tool's _meta.ui.resourceUri (or pass { uri: "ui://..." })
const session = await host.open({ tool: "show_dashboard", toolInput: { range: "7d" } });
await mountIframe(session, {
  container: document.getElementById("app")!,
  sandboxUrl: "https://sandbox.example.com/proxy.html", // DIFFERENT origin from this page
});

session.subscribe(() => console.log(session.getState().status)); // loaded -> connecting -> ready -> closed
await session.close();                                           // teardown handshake + iframe removed
```

### React

```tsx
import { useMcpApp } from "@johnhenry/mcp-query-ui/react";

function App({ host }) {
  const { containerRef, state, error } = useMcpApp(host, {
    tool: "show_dashboard",
    toolInput: { range: "7d" },
    sandboxUrl: "https://sandbox.example.com/proxy.html",
  });
  return (
    <>
      <div ref={containerRef} />
      {error && <p>Could not open the app: {error.message}</p>}
      <ul>{state?.calls.map((c) => <li key={c.id}>{c.target}: {c.outcome}</li>)}</ul>
    </>
  );
}
```

`useMcpApp` opens on mount, tears down on unmount (or when `uri`/`tool`/`sandboxUrl` change).
`useAppSession(session)` and `useAppSessions(host)` are the plain subscription hooks.

## What the host does

| Direction | Handling |
|---|---|
| host -> app | `ui/initialize` handshake, then `tool-input` / `tool-result` once the app reports `initialized`; `session.sendToolResult()` for later results |
| app `tools/call` | rejected unless the tool's `_meta.ui.visibility` includes `"app"` (spec MUST), then `client.callTool(name, args, { server, context })` |
| app `resources/read` | `client.readResource(uri, { server, context })` |
| app `ui/message` | appended to `state.messages`, then `onMessage` (return `{ isError: true }` to refuse). Treat as **untrusted input** before forwarding it to a model or chat |
| app `ui/open-link` | **refused by default**; `onOpenLink` opts in, and only `http(s)` URLs are ever offered |
| app `ui/request-teardown` / size changes | session closes / `state.size` updates |

Not forwarded: `resources/list`, `prompts/*`, sampling, `update-model-context`, downloads. The host
declares only `serverTools` + `serverResources` + `message` (+ `openLinks` when enabled).

## Security: running under the gate

Every app-initiated operation is a normal `MCPClient` operation, so whatever stack that client has
decides the outcome:

```ts
import { createGate } from "@johnhenry/mcp-gate";

const gate = await createGate({
  upstreams: { dash: { /* ... */ } },
  policy: { allow: ["dash.*"], approve: ["dash.save_*"], deny: ["dash.delete_*"] },
  approval: { handler: async (req) => (await askUser(req)) ? "allow" : "deny" },
  audit: (e) => log(e),
});
const host = createAppHost({ client: gate.client, server: "dash" });
```

- **allow / approve / deny:** policy ids are `server.tool` (reads: `server.<uri>`). Denied calls never
  reach the upstream; `approve` parks the call until your `approval.handler` (or a human via
  `gate.approvals`) decides, and fails closed. The app sees a JSON-RPC error; `state.calls[i].outcome`
  is `denied`.
- **The `ui://` resource read is gated too.** A policy with an `allow` list must include
  `server.ui://...` or the app will not load.
- **Identity:** every call carries `context.meta.principal = "mcp-app:<ui uri>"` (override via the
  `context` option), so gate audit entries and approval requests identify app-originated traffic.
  Add a tenant `partition` the same way.
- **App-only tools** (`visibility: ["app"]`) are callable by the app but hidden from the model;
  model-only tools are never callable by an app.

### Sandbox rules (from the spec) and how this package enforces them

- **Double iframe, different origin.** A web host MUST wrap the app in a *sandbox proxy* page served
  from a different origin than the host. `mountIframe` throws if `sandboxUrl` is same-origin as the
  host page, or plain `http` (except localhost). The outer iframe gets `sandbox="allow-scripts allow-same-origin"`
  (the proxy's own, separate origin), `referrerpolicy="no-referrer"`, and an `allow=` list built from the
  declared `permissions`.
- **Handshake.** The proxy sends `ui/notifications/sandbox-proxy-ready`; the host answers with
  `ui/notifications/sandbox-resource-ready` carrying the raw HTML, the validated `csp`, the
  `permissions`, and the inner `sandbox` attribute (default `allow-scripts`, i.e. an opaque origin;
  override with `innerSandbox`). The host sends nothing to the app before it reports `initialized`.
- **CSP from metadata, never loosened.** The server's declared `connectDomains` / `resourceDomains` /
  `frameDomains` / `baseUriDomains` are the *ceiling*. Each source must look like an `http(s)`/`ws(s)`
  origin (no whitespace, `;`, quotes, bare `*`), so hostile metadata cannot inject directives; the
  optional `allowDomain(domain, kind)` hook narrows further. With nothing declared the policy is the spec's
  restrictive default (`default-src 'none'`, `connect-src 'none'`, `frame-src 'none'`, `object-src 'none'`).
  `session.resource.csp` is what the proxy must enforce; `session.resource.cspHeader` is the exact header
  value (`buildAppCsp()` is exported for writing a proxy) -- log it for audit.
- **Postmessage validation.** The transport only accepts messages whose `event.source` is the sandbox
  iframe's window.
- **You own the proxy page.** It must apply the CSP *as an HTTP header or meta tag on the inner document*, forward
  all non-`ui/notifications/sandbox-*` messages unchanged in both directions, and never originate its own
  requests. The ext-apps repository has a reference host and sandbox page to start from.

## API

```ts
createAppHost({ client, server, hostInfo?, hostContext?, context?, allowDomain?, onMessage?, onOpenLink?, maxHistory?, teardownTimeoutMs? }): AppHost
host.open({ uri | tool, toolInput?, toolResult? }): Promise<AppSession>   // reads + validates the resource
host.getSessions() / host.subscribe(cb) / host.closeAll()

session.resource   // { html, csp, cspHeader, permissions, allow, domain?, ... }
session.getState() // { status, error?, appInfo?, appCapabilities?, size?, messages[], calls[] }
session.subscribe(cb)
session.connect(transport)   // any MCP Transport; mountIframe() does this for a sandbox iframe
session.whenReady(timeoutMs?) / session.sendToolResult(r) / session.addCleanup(fn) / session.close()

mountIframe(session, { container, sandboxUrl, innerSandbox?, title? })
mcpAppsExtensions()          // -> pass as MCPClientConfig.extensions
buildAppCsp(csp) / sanitizeCsp(csp, allow?) / isSafeCspSource(s)

// "@johnhenry/mcp-query-ui/react"
useMcpApp(host, { uri | tool, toolInput?, toolResult?, sandboxUrl?, mount?, enabled? }) -> { containerRef, session, state, error }
useAppSession(session) / useAppSessions(host)
```

`AppSessionState.status`: `loading | loaded | connecting | ready | closing | closed | error`.
`state.calls[i].outcome`: `pending | ok | denied | error`. The public surface is pinned by
`test/api.test.ts` (names + type-level shapes).

## Releasing

Published from `main` by `.github/workflows/release-mcp-query-ui.yml` (do not rename; npm trusted
publishing is keyed to the filename). A brand-new package cannot be created by trusted publishing, so
the **first** release is manual:

```bash
npm run build -w @johnhenry/mcp-query -w @johnhenry/mcp-query-ui
cd packages/mcp-query-ui && npm publish --access public   # 0.1.0, once, from a logged-in maintainer shell
npm trust github @johnhenry/mcp-query-ui --repository johnhenry/mcp-query --file release-mcp-query-ui.yml --allow-publish
```

After that, the Changesets "Version Packages" PR drives every release like the other packages.
