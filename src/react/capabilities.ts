// Reactive capability lists + prompts. These re-render when a server emits a
// *_list_changed notification (dynamic registration), because the connection layer
// invalidates the matching `caps:` tag, which we observe here.

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useMCPClient } from "./provider.js";
import type { CacheKey } from "../core/keys.js";
import type { Prompt, Resource, Tool } from "../core/types.js";

function useCapsList<T>(server: string, kind: "tools" | "resources" | "prompts", read: () => T[]): T[] {
  const client = useMCPClient();
  const key: CacheKey =
    kind === "tools"
      ? { kind: "toolList", server }
      : kind === "resources"
        ? { kind: "resourceList", server }
        : { kind: "promptList", server };

  // Subscribe to the caps cache entry so a re-list (list_changed) re-renders us.
  useSyncExternalStore(
    useCallback((cb) => client.cache.subscribe(key, cb), [client, server, kind]),
    () => client.cache.getVersion(key),
    () => client.cache.getVersion(key),
  );
  return read();
}

export function useTools(opts: { server: string }): { tools: Tool[] } {
  const client = useMCPClient();
  return { tools: useCapsList(opts.server, "tools", () => client.listTools(opts.server)) };
}

export function useResourceList(opts: { server: string }): { resources: Resource[] } {
  const client = useMCPClient();
  return { resources: useCapsList(opts.server, "resources", () => client.listResources(opts.server)) };
}

export function usePromptList(opts: { server: string }): { prompts: Prompt[] } {
  const client = useMCPClient();
  return { prompts: useCapsList(opts.server, "prompts", () => client.listPrompts(opts.server)) };
}

/** Fetch + render a server-provided prompt template (no Apollo analog). */
export function usePrompt(name: string, vars: Record<string, unknown>, server?: string) {
  const client = useMCPClient();
  const [data, setData] = useState<{ messages?: unknown[]; description?: string }>({});
  useEffect(() => {
    let live = true;
    client.getPrompt(name, vars, server).then((r) => live && setData(r as typeof data));
    return () => {
      live = false;
    };
  }, [client, name, server, JSON.stringify(vars)]);
  return data;
}
