// Router — the multiplexing brain. Resolves a bare tool name or resource URI to a
// specific server, the way an editor routes a request to one of N language servers.
// Policy: explicit "server.tool" wins; else unique match; else error on ambiguity.

import type { ServerConnection } from "./connection.js";
import type { Resource, Tool } from "./types.js";

export class AmbiguousCapability extends Error {
  constructor(
    readonly name: string,
    readonly servers: string[],
  ) {
    super(`"${name}" is offered by multiple servers: ${servers.join(", ")}. Qualify it as "<server>.${name}".`);
  }
}

export class CapabilityNotFound extends Error {
  constructor(name: string) {
    super(`No connected server offers "${name}".`);
  }
}

export class Router {
  constructor(
    private conns: Map<string, ServerConnection>,
    /** Optional scheme->server map for resources, e.g. { "file": "fs", "github": "github" }. */
    private schemeMap: Record<string, string> = {},
  ) {}

  resolveTool(name: string, server?: string): { server: string; def: Tool } {
    if (server) return { server, def: this.req(server, this.conns.get(server)?.tools.get(name), name) };
    if (name.includes(".")) {
      const [s, ...rest] = name.split(".");
      const tool = rest.join(".");
      return { server: s!, def: this.req(s!, this.conns.get(s!)?.tools.get(tool), tool) };
    }
    const hits = [...this.conns.values()].filter((c) => c.tools.has(name));
    if (hits.length === 0) throw new CapabilityNotFound(name);
    if (hits.length > 1) throw new AmbiguousCapability(name, hits.map((h) => h.name));
    return { server: hits[0]!.name, def: hits[0]!.tools.get(name)! };
  }

  resolveResource(uri: string, server?: string): { server: string; def?: Resource } {
    if (server) return { server, def: this.conns.get(server)?.resources.get(uri) };
    // 1) explicit catalog hit, 2) scheme map, 3) unique catalog match
    const scheme = uri.split(":")[0];
    if (scheme && this.schemeMap[scheme]) {
      const s = this.schemeMap[scheme]!;
      return { server: s, def: this.conns.get(s)?.resources.get(uri) };
    }
    const hits = [...this.conns.values()].filter((c) => c.resources.has(uri));
    if (hits.length === 1) return { server: hits[0]!.name, def: hits[0]!.resources.get(uri) };
    if (hits.length > 1) throw new AmbiguousCapability(uri, hits.map((h) => h.name));
    throw new CapabilityNotFound(uri);
  }

  private req<T>(server: string, v: T | undefined, name: string): T {
    if (v == null) throw new CapabilityNotFound(`${server}.${name}`);
    return v;
  }
}
