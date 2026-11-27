# WebSocket <-> stdio bridge protocol (v1)

A browser cannot spawn processes, so it cannot talk to a stdio MCP server directly. A **bridge**
is a small local program that accepts a WebSocket from the page, spawns (or dials) the MCP
server the page asks for, and relays JSON-RPC messages in both directions.

This document specifies the protocol that the reference bridge,
[`apps/shared/src/proxy.ts`](../../../apps/shared/src/proxy.ts) (`startProxy`), already speaks, and
that the reference browser transport,
[`apps/shared/src/transport.ts`](../../../apps/shared/src/transport.ts) (`WebSocketProxyTransport`),
already uses. Anyone can implement either side (for example a desktop companion app that offers
stdio servers to a browser host). Every rule below is pinned by
[`apps/shared/test/proxy.test.ts`](../../../apps/shared/test/proxy.test.ts) unless it is marked
*not pinned*.

Keywords MUST / SHOULD / MAY are used as in RFC 2119. "Reference bridge" means `startProxy`;
where it falls short of a MUST, the gap is listed under [remaining gaps](#reference-bridge-defaults-and-remaining-gaps).

> **Security first.** A bridge **spawns local processes on behalf of a web page**. A page the user
> did not intend, a DNS-rebinding attacker, or another local user can turn an unprotected bridge
> into remote code execution on the user's machine. A conforming bridge MUST do all of the
> following, and a host MUST NOT ship one that does not:
>
> 1. **Bind to loopback only** (`127.0.0.1`; never `0.0.0.0`, never a LAN address).
> 2. **Check `Origin`** against an explicit allowlist of the pages that may use it.
> 3. **Require a secret token** that the user's own tooling hands to the page (random, per run).
> 4. **Constrain what can be spawned**: ideally the bridge, not the page, owns the list of
>    commands. Treat the `connect` frame's `command`/`args`/`env` as attacker-controlled input.
>
> Items 2 and 3 are independent defences; keep both. Origin is not authentication (non-browser
> clients can send any Origin or none), and a token alone does not stop a page that learns it.

## 1. Transport and admission

- The bridge listens for WebSocket connections on `ws://127.0.0.1:<port>/`. Use the literal
  `127.0.0.1` in URLs; the reference bridge does not listen on `::1`, so `localhost` can resolve
  to an address that refuses the connection.
- The client presents the token as the **`token` query parameter**: `ws://127.0.0.1:6280/?token=<token>`.
  (Browsers cannot set arbitrary headers on a WebSocket, so a query parameter is the carrier.)
- The client's browser attaches `Origin` automatically. Non-browser clients may send none.

Admission order, all checked before any frame is processed:

| Check | Fails when | Result |
| --- | --- | --- |
| Token | `token` is absent or not equal to the bridge's token | Socket closed with code **1008**, reason `bad token` |
| Origin | an `Origin` header is present and not allowed | Socket closed with code **1008**, reason `bad origin` |
| Origin (missing) | no `Origin` header and the bridge requires one (the reference default) | Socket closed with code **1008**, reason `bad origin` |

The WebSocket handshake itself succeeds in both cases (the failure is a close frame after the
upgrade, not an HTTP 401/403). A client sees `open` and then an immediate `close` with 1008.

Defaults of the reference bridge (safe by default): a socket with **no `Origin` header is refused**,
and only loopback origins are accepted: `http://localhost`, `http://127.0.0.1` and `http://[::1]`, any
port (an exact scheme/host match). Everything else is refused, including `https://localhost`,
`http://192.168.1.5:5173`, `http://localhost.evil.example`, and the opaque origin `null`. A bridge for
a hosted page (for example `https://app.example`) MUST be configured with that exact origin.
Reference options: `allowedOrigins: [string | RegExp]` replaces the list; `requireOrigin: false` is the
explicit opt-out that admits sockets with no `Origin` (non-browser clients holding the token).

## 2. Framing

After admission, every WebSocket message is one **UTF-8 JSON text** object. There is no
length prefix and no newline framing at this layer (the newline-delimited framing of stdio is
handled between the bridge and the child process, not on the WebSocket). Each frame is exactly one of:

### Client -> bridge

| Frame | Meaning |
| --- | --- |
| `{"control": {"connect": <TargetSpec>}}` | Dial the target. Must be the first meaningful frame. |
| `{"msg": <JSON-RPC message>}` | Relay one MCP JSON-RPC message (request or notification) to the target. |
| `{"control": {"close": true}}` | Close the target. |

### Bridge -> client

| Frame | Meaning |
| --- | --- |
| `{"control": {"connected": true}}` | The target started; the client may now send `msg` frames. |
| `{"msg": <JSON-RPC message>}` | One JSON-RPC message from the target (response or notification). |
| `{"error": "<string>"}` | A non-fatal error report (transport error, or a failed send). |
| `{"error": "<string>", "control": {"failed": true}}` | `connect` failed. The bridge closes the socket next. |
| `{"control": {"closed": true}}` | The target closed. The bridge closes the socket next. |

`msg` payloads are opaque to the bridge: it relays them unchanged and does not inspect JSON-RPC
`id`s, so request/response correlation, timeouts and the MCP handshake (`initialize`, or the
2026-07-28 per-request metadata) are entirely the client's business. The bridge never originates
JSON-RPC traffic.

Frames the bridge does not understand are ignored without a reply and without closing the socket:
non-JSON text, JSON objects with none of the keys above, and `msg` frames sent before a successful
`connect` (silently dropped; the client MUST wait for `connected`). Clients SHOULD ignore unknown
frame shapes from the bridge for forward compatibility.

## 3. Selecting the target

The `connect` frame carries a `TargetSpec`:

```ts
interface TargetSpec {
  transport: "stdio" | "http" | "sse";
  // stdio
  command?: string;            // required for stdio
  args?: string[];             // default []
  env?: Record<string, string>;
  // http | sse
  url?: string;                // required for http / sse
  // hint for the client only; the bridge ignores it
  direct?: boolean;
}
```

- **stdio**: the bridge spawns `command args...`. The child's environment is the MCP SDK's
  *default safe environment* (`getDefaultEnvironment()`: a short allowlist such as `PATH`/`HOME`
  /`USER`, not the bridge's whole environment) overlaid with `env`. In particular a secret in the
  bridge's own environment is **not** inherited by the child (pinned). The child's
  stdin/stdout carry newline-delimited JSON-RPC (the MCP stdio transport); the bridge turns each
  stdout line into a `{"msg": ...}` frame and each `{"msg": ...}` frame into one stdin line.
- **http**: the bridge acts as a Streamable HTTP *client* to `url` and relays `msg` frames as POSTs
  (pinned against a local JSON-responding server). **sse**: the same with the legacy HTTP+SSE client transport.
  These let a page reach servers that lack CORS support (see the README's Browser section for the
  direct route and its CORS requirements). Setting `direct: true` is only a convention for clients to
  skip the bridge for http/sse (so OAuth can run in the page); the reference bridge ignores it.
- `command` is *the* dangerous field. Hosts that offer a fixed catalogue of servers SHOULD make
  the bridge resolve a **name to a command it owns** instead of accepting a raw command from the
  page. The reference bridge is **deny-by-default**: unless it is given an allowlist, every
  `connect` is refused with a `failed` frame (`error: "target not allowed"`, pinned) and nothing is
  spawned. Allow targets with `allowTargets: TargetRule[]` (exact `command`, exact `args` with
  optional `{ endsWith }` / `{ any: true }` items, `env` refused unless the rule sets `allowEnv`;
  http/sse rules match `url` exactly) and/or the `allowTarget(spec) => boolean` predicate.
  `allowAnyTarget: true` restores "run whatever the page asks": it is deliberately named as unsafe and
  logs a warning at startup. `apps/shared/src/proxy-cli.ts` reads rules from `./proxy-allow.json`
  in the app directory and enables the hatch only with `PROXY_ALLOW_ANY=1`.

A `connect` frame MUST be sent at most once per socket. (Sending a second one on the same socket
is undefined: the reference bridge replaces its target reference without closing the first process.)
Open another socket for another server.

## 4. Lifecycle

```
client                                   bridge                          target
  | --- WS open (?token=..., Origin) --->  |  admission (section 1)
  | --- {"control":{"connect":{...}}} -->  |  --- spawn / dial ------------>
  | <-- {"control":{"connected":true}} --  |  (target.start() resolved)
  | --- {"msg": initialize ...} ---------> |  --- stdin line --------------->
  | <-- {"msg": result ...} -------------  |  <-- stdout line --------------
  |                 ...
  | --- {"control":{"close":true}} ------> |  --- target.close() ----------->
  | <-- {"control":{"closed":true}} ------ |  (target closed)
  | <-- WS close ------------------------  |
```

Rules:

1. `connected` is sent only after the target started successfully; it is the only signal that
   `msg` frames will be delivered.
2. `{"control":{"close":true}}` closes the **target**. The bridge then reports
   `{"control":{"closed":true}}` and closes the socket (pinned). The socket is closed with a plain
   close (status 1005, no code) in this and the next two cases.
3. If the **target exits or closes by itself** (child process exit, HTTP transport closed) the bridge
   sends `{"control":{"closed":true}}` and closes the socket (pinned).
4. If the **socket closes** (page navigates away, tab closed, network drop) the bridge MUST close
   the target; for stdio that terminates the child process (pinned: the child is gone shortly after the socket closes).
5. If the **bridge shuts down**, it terminates all sockets, which triggers rule 4.
6. One socket is one target is one session. The bridge holds no state across sockets, and a
   reconnecting client starts again from `connect` (a new process for stdio).

## 5. Errors

| Situation | What the client sees |
| --- | --- |
| Bad/missing token | close 1008 `bad token` |
| Disallowed/missing Origin | close 1008 `bad origin` |
| `connect` with stdio and no `command`, or http/sse and no `url` | `{"error": "stdio target needs a command" \| "<transport> target needs a url", "control": {"failed": true}}`, then close |
| `connect` refused by `allowTarget` | `{"error": "target not allowed", "control": {"failed": true}}`, then close |
| Target cannot start (for example `ENOENT` for the command) | optionally a bare `{"error": "..."}` frame, then `{"error": "...", "control": {"failed": true}}`, then close |
| Target reports a transport error while running | `{"error": "<message>"}` (the socket stays open; a `closed` frame follows if the target then closes) |
| `send` to the target fails | `{"error": "<message>"}` (socket stays open) |
| Malformed JSON, unknown frame, `msg` before `connect` | nothing; ignored |

Clients MUST treat any `error` frame as informational unless it carries `control.failed`, and
MUST treat `failed`, `closed` or a WebSocket `close` as the end of the connection. `error`
strings are for humans; do not parse them.

## 6. Writing a client

`WebSocketProxyTransport` is a ~50-line MCP SDK `Transport` over this protocol and plugs into
`mcp-query` as a connection:

```ts
import { MCPClient } from "@johnhenry/mcp-query";
import { WebSocketProxyTransport } from "./transport"; // apps/shared/src/transport.ts

const client = new MCPClient({
  servers: {
    fs: {
      transport: () =>
        new WebSocketProxyTransport("ws://127.0.0.1:6280", token, {
          transport: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
        }),
    },
  },
});
```

`start()` opens the socket, sends `connect`, and resolves on `connected` (rejecting on `failed`
or an error before the ack); `send()` wraps the message in `{"msg": ...}`; `close()` sends
`{"control":{"close":true}}` and closes the socket.

## Reference bridge: defaults and remaining gaps

Defaults (a behaviour change from earlier versions of `startProxy`, which admitted a missing `Origin`
and any `localhost` origin, and spawned any requested command): loopback bind, token required,
`Origin` required and loopback-only, **no target allowed until configured**. The remaining weaker spots:

| Gap | Today | Mitigation |
| --- | --- | --- |
| Token in the URL | The token is a query parameter, so it can land in logs, history and process listings; the comparison is not constant-time | Per-run random token (the default is a random UUID), keep the bridge short-lived |
| No resource limits | No idle timeout, no connection cap, no rate limit, and the `ws` default maximum message size (100 MiB) | Run the bridge only while it is needed |
| Allowed `args` are the whole surface | A rule that permits `{ any: true }` for an argument (for example a directory) trusts the page for that value | Prefer exact args; only `any` where the program is itself safe with any value |
| Second `connect` on one socket | Leaks the first target process until the socket closes | Clients must not do this (not pinned) |
| `port: 0` | The returned `url` echoes `0` rather than the bound port | Pass an explicit port |
| Token printed | `proxy-cli.ts` prints a URL containing the token; `PROXY_PORT` / `PROXY_TOKEN` env vars are honoured | Do not run it in shared terminals or CI logs |
| Escape hatch | `allowAnyTarget` / `PROXY_ALLOW_ANY=1` lets a token holder run any command. The `composer`, `console` and `ops-cockpit` dev scripts use it because their UI lets the user type an arbitrary server command | Only for local dev tools of that kind |

## Conformance

A bridge implementation can be checked with the executable spec in
[`apps/shared/test/proxy.test.ts`](../../../apps/shared/test/proxy.test.ts); it drives real WebSocket
clients against `startProxy` and a real stdio child
([`test/fixtures/stdio-echo.mjs`](../../../apps/shared/test/fixtures/stdio-echo.mjs)). Run it with
`npm test -w @mcp-query/app-shared`.
