// React adapter for the framework-free host. Kept on its own subpath so the root entry never
// imports React.
import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { mountIframe } from "./iframe.js";
import type { AppHost, AppSession, OpenAppOptions } from "./host.js";
import type { AppSessionState } from "./types.js";

const noopSubscribe = () => () => {};
const noState = () => undefined;

/** Subscribe to one session's state (lifecycle, messages, app-initiated calls). `undefined` until it exists. */
export function useAppSession(session: AppSession | undefined): AppSessionState | undefined {
  return useSyncExternalStore(session ? session.subscribe : noopSubscribe, session ? session.getState : noState, noState);
}

/** The host's live session list (re-renders when one opens or closes). */
export function useAppSessions(host: AppHost): readonly AppSession[] {
  return useSyncExternalStore(host.subscribe, host.getSessions, host.getSessions);
}

export interface UseMcpAppOptions extends OpenAppOptions {
  /** Sandbox proxy page for the default iframe mount (must be a different origin than the host page). */
  sandboxUrl?: string;
  /** Replace the default iframe mount (e.g. a custom transport). Receives the opened session and the container element. */
  mount?: (session: AppSession, container: HTMLElement) => Promise<void>;
  /** Skip mounting while false (e.g. until a tool call has produced a result). Default true. */
  enabled?: boolean;
}

export interface UseMcpAppResult {
  /** Attach to the element the app should render into. */
  containerRef: RefObject<HTMLDivElement | null>;
  session: AppSession | undefined;
  /** Reactive session state; `undefined` before the resource has loaded. */
  state: AppSessionState | undefined;
  /** Failure while opening/mounting (resource refused, gate denied the read, bad sandbox URL, ...). */
  error: Error | undefined;
}

/**
 * Mount an MCP App for the lifetime of the component: opens the `ui://` resource through the
 * (gated) client, attaches it to `containerRef`, and tears it down on unmount or when
 * `uri`/`tool`/`sandboxUrl` change. `toolInput`/`toolResult` are delivered once, at open time;
 * use `session.sendToolResult()` for later updates.
 */
export function useMcpApp(host: AppHost, options: UseMcpAppOptions): UseMcpAppResult {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [session, setSession] = useState<AppSession | undefined>();
  const [error, setError] = useState<Error | undefined>();
  const latest = useRef(options);
  latest.current = options;
  const enabled = options.enabled ?? true;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let opened: AppSession | undefined;
    setError(undefined);
    void (async () => {
      try {
        const o = latest.current;
        opened = await host.open({ uri: o.uri, tool: o.tool, toolInput: o.toolInput, toolResult: o.toolResult });
        if (cancelled) return void (await opened.close());
        setSession(opened);
        const el = containerRef.current;
        if (!el) throw new Error("useMcpApp: containerRef is not attached to an element");
        if (o.mount) await o.mount(opened, el);
        else if (o.sandboxUrl) await mountIframe(opened, { container: el, sandboxUrl: o.sandboxUrl });
        else throw new Error("useMcpApp: provide `sandboxUrl` (or a custom `mount`)");
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e : new Error(String(e)));
        await opened?.close();
      }
    })();
    return () => {
      cancelled = true;
      setSession(undefined);
      void opened?.close();
    };
  }, [host, options.uri, options.tool, options.sandboxUrl, enabled]);

  const state = useAppSession(session);
  return { containerRef, session, state, error };
}
