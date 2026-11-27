// useSkills / useSkill — Skills over MCP (io.modelcontextprotocol/skills, SEP-2640)
// as reactive data. Backed by the same cache as client.listSkills/getSkill: a
// resources list_changed marks the catalog stale and these hooks re-fetch it.
// Needs SDK >= 2.4.0; on an older SDK `error` carries the explanatory MCPError.

import { useCallback, useEffect } from "react";
import { useVersioned } from "@johnhenry/agent-query-core/react";
import { useMCPClient } from "./provider.js";
import type { CacheKey } from "../core/keys.js";
import type { Skill, SkillFile } from "../core/skills.js";
import type { MCPError } from "../core/types.js";

export interface UseSkillsOptions {
  /** Skip the fetch entirely. */
  skip?: boolean;
  /** Freshness window (ms); default is the server's `ttlMs`. */
  staleTime?: number;
}

export interface UseSkillsResult {
  /** Skills of `server`, or the union across skills-capable servers; every entry carries its `server`. */
  skills: Skill[];
  error?: MCPError;
  isLoading: boolean;
  isStale: boolean;
  refetch: () => Promise<void>;
}

/** Targets: the named server, or every connection that advertises the skills extension. */
function useTargets(server: string | undefined) {
  const client = useMCPClient();
  // Re-evaluate when connections change state (capabilities arrive on connect) or any skills entry changes.
  useVersioned(
    useCallback(
      (cb) => {
        const offState = client.subscribeServerState(cb);
        const offCache = client.cache.subscribeAll(cb);
        return () => {
          offState();
          offCache();
        };
      },
      [client],
    ),
    () => client.serverStateVersion() + versionOf(client, server),
    () => client.serverStateVersion() + versionOf(client, server),
  );
  const names = server
    ? [server]
    : client
        .connections()
        .filter((c) => c.supports("skills"))
        .map((c) => c.name);
  return { client, names };
}

function versionOf(client: ReturnType<typeof useMCPClient>, server: string | undefined): number {
  let v = 0;
  for (const c of client.connections()) {
    if (server && c.name !== server) continue;
    v += client.cache.getVersion({ kind: "skillList", server: c.name });
  }
  return v;
}

export function useSkills(server?: string, opts: UseSkillsOptions = {}): UseSkillsResult {
  const { client, names } = useTargets(server);
  const keyOf = (s: string): CacheKey => ({ kind: "skillList", server: s });

  const refetch = useCallback(
    async () => {
      await Promise.all(
        names.map((s) =>
          client.listSkills(s, { force: true, staleTime: opts.staleTime }).catch(() => {}), // errors land on the entry
        ),
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, names.join("\0"), opts.staleTime],
  );

  // Fetch when missing or stale. Keyed on (success, stale) flags — NOT on the error state — so a
  // failing server is not re-requested in a loop.
  const flags = names
    .map((s) => {
      const e = client.cache.getSnapshot(keyOf(s));
      return `${e?.status === "success" ? 1 : 0}${client.cache.isStale(keyOf(s)) ? 1 : 0}`;
    })
    .join(",");
  useEffect(() => {
    if (opts.skip) return;
    for (const s of names) {
      if (client.cache.isStale(keyOf(s)) && !client.cache.inflight(keyOf(s))) {
        void client.listSkills(s, { staleTime: opts.staleTime }).catch(() => {});
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, opts.skip, opts.staleTime, names.join("\0"), flags]);

  const entries = names.map((s) => client.cache.getSnapshot(keyOf(s)));
  const skills = entries.flatMap((e) => (e?.status === "success" ? ((e.data as Skill[] | undefined) ?? []) : []));
  const error = entries.find((e) => e?.status === "error")?.error as MCPError | undefined;
  return {
    skills,
    error,
    isLoading: !opts.skip && names.length > 0 && entries.some((e) => !e || e.status === "fetching" || e.status === "idle"),
    isStale: names.some((s) => client.cache.isStale(keyOf(s))),
    refetch,
  };
}

export interface UseSkillOptions {
  /** The publishing server. Omit to resolve the URI from the skills catalog of every server. */
  server?: string;
  skip?: boolean;
  staleTime?: number;
}

export interface UseSkillResult {
  skill?: Skill;
  error?: MCPError;
  isLoading: boolean;
  refetch: () => Promise<void>;
  /** Read one verified file of this skill (default `SKILL.md`). Not fetched ahead of need. */
  readFile: (ref?: string) => Promise<SkillFile>;
}

export function useSkill(uri: string, opts: UseSkillOptions = {}): UseSkillResult {
  const client = useMCPClient();
  const { server, skip, staleTime } = opts;
  // Without a server, find the skill in the catalog (which also fetches/refreshes it).
  const catalog = useSkills(server, { skip: skip || server !== undefined });
  const fromCatalog = server === undefined ? catalog.skills.find((s) => s.uri === uri) : undefined;
  const resolvedServer = server ?? fromCatalog?.server;

  const key: CacheKey | undefined = server ? { kind: "skill", server, uri } : undefined;
  useVersioned(
    useCallback((cb) => (key ? client.cache.subscribe(key, cb) : () => {}), [client, key?.server, uri]),
    () => (key ? client.cache.getVersion(key) : 0),
    () => (key ? client.cache.getVersion(key) : 0),
  );

  const stale = key ? client.cache.isStale(key) : false;
  useEffect(() => {
    if (skip || !server || !key) return;
    if (client.cache.isStale(key) && !client.cache.inflight(key)) void client.getSkill(uri, server, { staleTime }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, skip, server, uri, staleTime, stale]);

  const entry = key ? client.cache.getSnapshot(key) : undefined;
  const skill = server ? (entry?.status === "success" ? (entry.data as Skill) : undefined) : fromCatalog;
  const refetch = useCallback(async () => {
    if (server) await client.getSkill(uri, server, { force: true, staleTime }).then(() => {}, () => {});
    else await catalog.refetch();
  }, [client, server, uri, staleTime, catalog.refetch]);

  return {
    skill,
    error: (server ? (entry?.error as MCPError | undefined) : catalog.error),
    isLoading: skip ? false : server ? !entry || entry.status === "fetching" || entry.status === "idle" : catalog.isLoading,
    refetch,
    readFile: useCallback(
      (ref?: string) => {
        if (!skill) return Promise.reject(new Error(`useSkill: skill ${uri} is not loaded yet${resolvedServer ? "" : " (unknown server)"}`));
        return client.readSkillFile(skill, ref);
      },
      [client, skill, uri, resolvedServer],
    ),
  };
}
