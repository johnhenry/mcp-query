// Node-only transport resolution for declarative upstreams (#37). Split out of config.ts:
// GateConfig/GatePolicy/compilePolicy/policyListFilter in config.ts are pure logic with zero
// runtime imports — safe to bundle for a browser dashboard. Building an actual stdio
// transport isn't: `@modelcontextprotocol/client/stdio` imports `cross-spawn` and
// `node:stream` at module scope, and spawning a child process only makes sense in Node
// anyway, so that import lives here instead, in a file the browser entry
// (`index.browser.ts` / the `browser` export condition, see package.json) never reaches —
// not even transitively. That's what actually fixes #37: the package `browser` condition
// resolves `.` to a graph that never imports this module, so a bundler never has to resolve
// cross-spawn/node:stream at all, static or dynamic.
//
// (`resolveUpstream`'s `transport` field must stay a *synchronous* `() => Transport` — see
// mcp-query's `ConnectionConfig.transport: (ctx?) => Transport` — so a lazy `await import()`
// inside the returned factory isn't an option here; the import has to happen eagerly, at
// module scope, in whichever file actually needs it.)

import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { ConnectionConfig } from "@johnhenry/mcp-query";
import type { ChildProcess } from "node:child_process";
import type { GateUpstream } from "./config.js";

/**
 * A stdio transport whose `close()` does not resolve until the child it spawned has really
 * exited (#23). The SDK's own `close()` ends stdin, waits up to 2s, sends SIGTERM, waits up
 * to 2s, then fires SIGKILL and returns without awaiting the exit — so a child that ignores
 * SIGTERM can outlive the promise. This subclass finishes the job: SIGKILL if still alive,
 * then await the exit event. It also makes a concurrent second `close()` (which the SDK
 * returns from immediately) wait for the same exit.
 */
export class ReapingStdioTransport extends StdioClientTransport {
  private child?: ChildProcess;
  private exited?: Promise<void>;

  override async start(): Promise<void> {
    const started = super.start();
    // The SDK assigns its private `_process` synchronously inside start().
    const child = (this as unknown as { _process?: ChildProcess })._process;
    if (child) {
      this.child = child;
      this.exited = new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        child.once("exit", () => resolve());
        child.once("error", () => child.pid === undefined && resolve()); // never spawned
      });
    }
    return started;
  }

  override async close(): Promise<void> {
    await super.close();
    await this.reap();
  }

  /** SIGKILL the child if it is still running and wait for it to exit. Idempotent. */
  async reap(): Promise<void> {
    const child = this.child;
    if (!child || !this.exited) return;
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
    await this.exited;
  }
}

/** Normalize an upstream to a ConnectionConfig, building the transport factory for declarative specs. */
export function resolveUpstream(upstream: GateUpstream): ConnectionConfig {
  if ("transport" in upstream) return upstream;
  if ("command" in upstream) {
    const { command, args = [], env } = upstream;
    return {
      transport: () =>
        new ReapingStdioTransport({ command, args, ...(env ? { env: { ...getDefaultEnvironment(), ...env } } : {}) }),
    };
  }
  const { url, headers, getToken } = upstream;
  return {
    transport: () =>
      new StreamableHTTPClientTransport(new URL(url), {
        ...(headers ? { requestInit: { headers } } : {}),
        ...(getToken ? { authProvider: { token: async () => getToken() } } : {}),
      }),
  };
}
