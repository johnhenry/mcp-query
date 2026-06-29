// useTool — the useMutation analog. Returns [invoke, state]. Validates args against
// the tool's inputSchema (so a non-agentic UI can bind a form to it), applies
// optimistic patches, and runs RTK-Query-style tag invalidation on success.

import { useCallback, useMemo, useRef, useState } from "react";
import { useMCPClient } from "./provider.js";
import type { CallToolOpts } from "../core/client.js";
import type { MCPError } from "../core/types.js";

export interface UseToolState<R> {
  isPending: boolean;
  data?: R;
  error?: MCPError;
  /** The tool's input JSON Schema — drive an auto-generated form / validation off this. */
  inputSchema?: Record<string, unknown>;
  /** The tool's output JSON Schema, if it declares one (for typing structuredContent). */
  outputSchema?: Record<string, unknown>;
  /** annotations.destructiveHint — gate a confirmation dialog on this. */
  isDestructive: boolean;
  /** Live progress from notifications/progress, if the tool reports any. */
  progress?: { progress: number; total?: number };
  /** Abort the in-flight call. */
  cancel: () => void;
  reset: () => void;
}

export function useTool<A extends Record<string, unknown> = Record<string, unknown>, R = unknown>(
  name: string,
  opts: Omit<CallToolOpts<A, R>, "signal"> = {},
): [(args: A, runtime?: { signal?: AbortSignal }) => Promise<R>, UseToolState<R>] {
  const client = useMCPClient();
  const [state, setState] = useState<{
    isPending: boolean;
    data?: R;
    error?: MCPError;
    progress?: { progress: number; total?: number };
  }>({ isPending: false });
  const abortRef = useRef<AbortController | undefined>(undefined);
  // Read the latest opts without making `invoke` depend on the opts object's identity —
  // callers routinely pass an inline `{ server }` literal (a new ref every render), and a
  // changing `invoke` breaks consumers that put it in a useEffect dependency (infinite loop).
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const def = useMemo(() => {
    try {
      return client.connections().flatMap((c) => [...c.tools.values()]).find((t) =>
        name.includes(".") ? name.endsWith(`.${t.name}`) : t.name === name,
      );
    } catch {
      return undefined;
    }
  }, [client, name]);

  const invoke = useCallback(
    async (args: A, runtime?: { signal?: AbortSignal }) => {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      const signal = runtime?.signal ?? ac.signal;
      setState((s) => ({ ...s, isPending: true, error: undefined, progress: undefined }));
      try {
        const result = await client.callTool<A, R>(name, args, {
          ...optsRef.current,
          signal,
          onProgress: (p) => setState((s) => ({ ...s, progress: p })),
        });
        setState({ isPending: false, data: result });
        return result;
      } catch (err) {
        setState({ isPending: false, error: err as MCPError });
        throw err;
      }
    },
    [client, name],
  );

  return [
    invoke,
    {
      ...state,
      inputSchema: def?.inputSchema as Record<string, unknown> | undefined,
      outputSchema: def?.outputSchema as Record<string, unknown> | undefined,
      isDestructive: def?.annotations?.destructiveHint === true,
      cancel: () => abortRef.current?.abort(),
      reset: () => setState({ isPending: false }),
    },
  ];
}
