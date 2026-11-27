// queryOptions() factories bridging mcp-query's own reads into TanStack Query.
// Sync propagation (attachMcpqSync, in bridge.ts) is what actually keeps a
// bridged query's TanStack cache entry fresh on protocol push / optimistic
// patch — the queryFn here only supplies the FIRST fetch + the type-safe
// queryKey/queryFn pairing queryOptions() exists for.

import { queryOptions, type UseQueryOptions } from "@tanstack/react-query";
import {
  argsHash,
  type CallToolOpts,
  type MCPClient,
  type QueryToolOpts,
  type ReadResourceOpts,
  type Skill,
  type SkillFile,
  type SkillOpts,
  type Tool,
} from "@johnhenry/mcp-query";
import { listQueryKey, resourceQueryKey, skillFileQueryKey, skillQueryKey, skillsQueryKey, toolResultQueryKey } from "./keys.js";
import { ensureSynced } from "./bridge.js";

/**
 * Bridges a READ-ONLY tool (annotated `readOnlyHint`) as a query — the
 * TanStack-side analog of mcp-query's own `useToolResult` hook. Do not use for
 * side-effecting tool calls; see `mcpqToolMutationOptions` for those.
 */
export function mcpqToolQueryOptions<A extends Record<string, unknown>, R = unknown>(
  client: MCPClient,
  name: string,
  args: A,
  opts: QueryToolOpts & Partial<UseQueryOptions<R>> = {},
) {
  const server = opts.server ?? resolveServer(client, name);
  const tool = bareName(name);
  const hash = argsHash(args);
  const key = toolResultQueryKey(server, tool, hash);
  return queryOptions<R>({
    ...opts,
    queryKey: key,
    queryFn: async ({ client: queryClient }) => {
      ensureSynced(client, queryClient, { kind: "toolResult", server, tool, argsHash: hash }, key);
      return client.queryTool<A, R>(name, args, opts);
    },
  });
}

/** Bridges `readResource` as a query. */
export function mcpqResourceQueryOptions<T = unknown>(
  client: MCPClient,
  uri: string,
  opts: ReadResourceOpts & Partial<UseQueryOptions<T>> = {},
) {
  const server = opts.server ?? resolveResourceServer(client, uri);
  const key = resourceQueryKey(server, uri);
  return queryOptions<T>({
    ...opts,
    queryKey: key,
    queryFn: async ({ client: queryClient }) => {
      ensureSynced(client, queryClient, { kind: "resource", server, uri }, key);
      return client.readResource(uri, opts) as Promise<T>;
    },
  });
}

/** Bridges a server's tool list as a query. */
export function mcpqToolListQueryOptions(client: MCPClient, server: string, opts: Partial<UseQueryOptions<Tool[]>> = {}) {
  const key = listQueryKey(server, "tools");
  return queryOptions<Tool[]>({
    ...opts,
    queryKey: key,
    queryFn: async ({ client: queryClient }) => {
      ensureSynced(client, queryClient, { kind: "toolList", server }, key);
      return client.listTools(server);
    },
  });
}

/**
 * Bridges `client.listSkills(server)` (Skills over MCP) as a query. Needs @johnhenry/mcp-query >= 0.6.0
 * and an SDK that ships `ext/skills` (>= 2.4.0); otherwise the query errors with the client's explanatory
 * `MCPError`. A resources `list_changed` makes it stale through the bridge. Pass
 * `client.scope({ partition })`'s partition as `context` to keep tenants apart.
 */
export function mcpqSkillsQueryOptions(client: MCPClient, server: string, opts: SkillOpts & Partial<UseQueryOptions<Skill[]>> = {}) {
  const partition = opts.context?.partition;
  const key = skillsQueryKey(server, partition);
  return queryOptions<Skill[]>({
    ...opts,
    queryKey: key,
    queryFn: async ({ client: queryClient }) => {
      ensureSynced(client, queryClient, { kind: "skillList", server, partition }, key);
      return client.listSkills(server, opts);
    },
  });
}

/** Bridges `client.getSkill(uri, server)` (one skill by its `SKILL.md` URI) as a query. */
export function mcpqSkillQueryOptions(client: MCPClient, uri: string, server: string, opts: SkillOpts & Partial<UseQueryOptions<Skill>> = {}) {
  const partition = opts.context?.partition;
  const key = skillQueryKey(server, uri, partition);
  return queryOptions<Skill>({
    ...opts,
    queryKey: key,
    queryFn: async ({ client: queryClient }) => {
      ensureSynced(client, queryClient, { kind: "skill", server, uri, partition }, key);
      return client.getSkill(uri, server, opts);
    },
  });
}

/**
 * Bridges `client.readSkillFile(skill, ref)` as a query: one SDK-verified file (default `SKILL.md`).
 * Keyed by the file's manifest digest, so a changed manifest is a different query. A `"dynamic"` skill's
 * files are unverified and never cached by mcp-query: this query gets `staleTime: 0` unless you set one.
 * With `skillApproval` on the client, the first fetch asks the InteractionBroker (a denial is the query error).
 */
export function mcpqSkillFileQueryOptions(
  client: MCPClient,
  skill: Skill,
  ref?: string,
  opts: SkillOpts & Partial<UseQueryOptions<SkillFile>> = {},
) {
  const partition = opts.context?.partition;
  const entry = manifestEntryFor(skill, ref);
  const key = skillFileQueryKey(skill.server, entry?.uri ?? ref ?? skill.uri, entry?.digest ?? "dynamic", partition);
  return queryOptions<SkillFile>({
    ...(entry ? {} : { staleTime: 0 }),
    ...opts,
    queryKey: key,
    queryFn: async ({ client: queryClient }) => {
      if (entry) ensureSynced(client, queryClient, { kind: "skillFile", server: skill.server, uri: entry.uri, digest: entry.digest, partition }, key);
      return client.readSkillFile(skill, ref, opts);
    },
  });
}

/** The manifest entry `ref` (default: the skill's own SKILL.md) names; undefined for dynamic skills / unlisted refs. */
function manifestEntryFor(skill: Skill, ref?: string): { uri: string; digest: string } | undefined {
  if (skill.resources === "dynamic") return undefined;
  const bare = (ref ?? skill.uri).split("#")[0]!;
  const root = skill.uri.slice(0, skill.uri.lastIndexOf("/") + 1);
  const absolute = /^[a-z][a-z0-9+.-]*:/i.test(bare) ? bare : root + bare.replace(/^\.\//, "");
  return skill.resources.find((r) => r.uri === absolute);
}

function bareName(name: string): string {
  return name.includes(".") ? name.split(".").slice(1).join(".") : name;
}

function resolveServer(client: MCPClient, name: string): string {
  if (name.includes(".")) return name.split(".")[0]!;
  for (const c of client.connections()) if (c.tools.has(name)) return c.name;
  return "default";
}

function resolveResourceServer(client: MCPClient, uri: string): string {
  for (const c of client.connections()) if (client.listResources(c.name).some((r) => r.uri === uri)) return c.name;
  return "default";
}
