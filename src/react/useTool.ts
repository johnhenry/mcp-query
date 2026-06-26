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
  /** The tool's JSON Schema — drive an auto-generated form / validation off this. */
  inputSchema?: Record<string, unknown>;
  /** annotations.destructiveHint — gate a confirmation dialog on this. */
  isDestructive: boolean;
  reset: () => void;
}

export function useTool<A extends Record<string, unknown> = Record<string, unknown>, R = unknown>(
  name: string,
  opts: Omit<CallToolOpts<A, R>, "signal"> = {},
): [(args: A, runtime?: { signal?: AbortSignal }) => Promise<R>, UseToolState<R>] {
  const client = useMCPClient();
  const [state, setState] = useState<{ isPending: boolean; data?: R; error?: MCPError }>({ isPending: false });
  const abortRef = useRef<AbortController | undefined>(undefined);

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
      setState((s) => ({ ...s, isPending: true, error: undefined }));
      try {
        const result = await client.callTool<A, R>(name, args, { ...opts, signal });
        setState({ isPending: false, data: result });
        return result;
      } catch (err) {
        setState({ isPending: false, error: err as MCPError });
        throw err;
      }
    },
    [client, name, opts],
  );

  return [
    invoke,
    {
      ...state,
      inputSchema: def?.inputSchema as Record<string, unknown> | undefined,
      isDestructive: def?.annotations?.destructiveHint === true,
      reset: () => setState({ isPending: false }),
    },
  ];
}
