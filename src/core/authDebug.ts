// Auth debugging surface — wraps an SDK OAuthClientProvider and records every step of
// the OAuth handshake (client registration, token reads/writes, the authorization
// redirect, PKCE verifier) so a debugger UI can show what happened. mcp-query doesn't
// own the OAuth flow (the SDK does); this just makes it observable.

export interface AuthStep {
  at: number;
  member: string;
  phase: "get" | "call" | "resolved";
  /** Redacted summary — never the raw secret. */
  detail?: unknown;
}

const SENSITIVE_GETTERS = new Set(["redirectUrl", "clientMetadata", "clientMetadataUrl"]);

/** Redact step detail so tokens/verifiers never land in a log. */
function summarize(member: string, value: unknown): unknown {
  if (member.startsWith("saveTokens") || member.startsWith("tokens")) {
    const t = (Array.isArray(value) ? value[0] : value) as { access_token?: string; refresh_token?: string } | undefined;
    return t ? { hasAccessToken: !!t.access_token, hasRefreshToken: !!t.refresh_token } : undefined;
  }
  if (member.startsWith("redirectToAuthorization")) {
    const url = Array.isArray(value) ? value[0] : value;
    return { authorizationUrl: String(url) };
  }
  if (member.includes("CodeVerifier") || member.includes("codeVerifier")) return "[redacted]";
  return undefined;
}

/** Wrap an OAuthClientProvider so each interaction is recorded. Adds `authSteps()`. */
export function instrumentAuthProvider<T extends object>(
  inner: T,
  onStep?: (s: AuthStep) => void,
): T & { authSteps: () => readonly AuthStep[] } {
  const steps: AuthStep[] = [];
  const record = (s: AuthStep) => {
    steps.push(s);
    if (steps.length > 500) steps.shift();
    onStep?.(s);
  };

  return new Proxy(inner, {
    get(target, prop, recv) {
      if (prop === "authSteps") return () => steps;
      const v = Reflect.get(target, prop, recv);
      const member = String(prop);
      if (typeof v === "function") {
        return (...args: unknown[]) => {
          record({ at: Date.now(), member, phase: "call", detail: summarize(member, args) });
          const out = (v as (...a: unknown[]) => unknown).apply(target, args);
          if (out && typeof (out as Promise<unknown>).then === "function") {
            return (out as Promise<unknown>).then((r) => {
              record({ at: Date.now(), member, phase: "resolved", detail: summarize(member, r) });
              return r;
            });
          }
          return out;
        };
      }
      if (SENSITIVE_GETTERS.has(member)) record({ at: Date.now(), member, phase: "get" });
      return v;
    },
  }) as T & { authSteps: () => readonly AuthStep[] };
}
