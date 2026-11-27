// Auth debugging surface — wraps an SDK OAuthClientProvider and records every step of
// the OAuth handshake (client registration, token reads/writes, the authorization
// redirect, PKCE verifier) so a debugger UI can show what happened. mcp-query doesn't
// own the OAuth flow (the SDK does); this just makes it observable.
//
// v2 note: the SDK detects providers by member presence and wraps them itself; a
// Proxy forwards property reads, so instrumented providers keep passing those
// guards. v2 providers also carry SEP-2352 issuer-binding members
// (discoveryState/saveDiscoveryState, issuer-keyed credential contexts) — the
// wrapper forwards them verbatim (it never strips arguments), and summarize()
// records them with secrets redacted.

export interface AuthStep {
  at: number;
  member: string;
  phase: "get" | "call" | "resolved";
  /** Redacted summary — never the raw secret. */
  detail?: unknown;
}

const SENSITIVE_GETTERS = new Set(["redirectUrl", "clientMetadata", "clientMetadataUrl"]);

/** Registration mechanism for a stored client: a CIMD client_id IS the provider's metadata URL. */
function registrationOf(inner: object, clientId: string | undefined): "cimd" | "dcr" | undefined {
  if (!clientId) return undefined;
  const url = (inner as { clientMetadataUrl?: string }).clientMetadataUrl;
  return url && clientId === url ? "cimd" : "dcr";
}

/** Redact step detail so tokens/verifiers never land in a log. */
function summarize(member: string, value: unknown, inner: object = {}): unknown {
  if (member === "dpop") {
    // DPoP (RFC 9449, SDK >= 2.1.0): the key's RFC 7638 thumbprint is public by design (it is
    // the token's cnf.jkt); the key itself is never read, so it cannot reach a log.
    const s = (Array.isArray(value) ? undefined : value) as { thumbprint?: string; alg?: string } | undefined;
    return s ? { thumbprint: s.thumbprint, alg: s.alg } : undefined;
  }
  if (member.startsWith("saveClientInformation") || (member.startsWith("clientInformation") && !Array.isArray(value))) {
    // Which registration mechanism produced this client (CIMD vs DCR). Never the secret.
    const c = (Array.isArray(value) ? value[0] : value) as { client_id?: string; client_secret?: string } | undefined;
    return c ? { registration: registrationOf(inner, c.client_id), clientId: c.client_id, hasClientSecret: !!c.client_secret } : undefined;
  }
  if (member.startsWith("saveTokens") || member.startsWith("tokens")) {
    const t = (Array.isArray(value) ? value[0] : value) as { access_token?: string; refresh_token?: string } | undefined;
    return t ? { hasAccessToken: !!t.access_token, hasRefreshToken: !!t.refresh_token } : undefined;
  }
  if (member.startsWith("redirectToAuthorization")) {
    const url = Array.isArray(value) ? value[0] : value;
    return { authorizationUrl: String(url) };
  }
  if (member.includes("CodeVerifier") || member.includes("codeVerifier")) return "[redacted]";
  if (member.startsWith("saveDiscoveryState") || member.startsWith("discoveryState")) {
    // SEP-2352 issuer binding: issuer/resourceMetadataUrl are safe (and useful) to log.
    const d = (Array.isArray(value) ? value[0] : value) as
      | {
          issuer?: string;
          authorizationServerUrl?: string;
          resourceMetadataUrl?: string;
          authorizationServerMetadata?: {
            issuer?: string;
            client_id_metadata_document_supported?: boolean;
            registration_endpoint?: string;
            authorization_response_iss_parameter_supported?: boolean;
            dpop_signing_alg_values_supported?: string[];
          };
        }
      | undefined;
    if (!d) return undefined;
    const m = d.authorizationServerMetadata;
    return {
      issuer: d.issuer ?? m?.issuer ?? d.authorizationServerUrl,
      resourceMetadataUrl: d.resourceMetadataUrl,
      // What the client can choose from: CIMD if advertised, else DCR if there is an endpoint.
      cimdSupported: m?.client_id_metadata_document_supported === true,
      dcrAvailable: !!m?.registration_endpoint,
      issParameterSupported: m?.authorization_response_iss_parameter_supported === true,
      dpopAlgs: m?.dpop_signing_alg_values_supported,
    };
  }
  if (member.startsWith("invalidateCredentials")) {
    return { scope: Array.isArray(value) ? value[0] : value };
  }
  return undefined;
}

/** Wrap an OAuthClientProvider so each interaction is recorded. Adds `authSteps()`. */
export function instrumentAuthProvider<T extends object>(
  inner: T,
  onStep?: (s: AuthStep) => void,
): T & { authSteps: () => readonly AuthStep[]; authNote: (member: string, detail?: unknown) => void } {
  const steps: AuthStep[] = [];
  let lastDiscovery: unknown;
  const record = (s: AuthStep) => {
    steps.push(s);
    if (steps.length > 500) steps.shift();
    onStep?.(s);
  };

  return new Proxy(inner, {
    get(target, prop, recv) {
      if (prop === "authSteps") return () => steps;
      if (prop === "authNote") return (member: string, detail?: unknown) => record({ at: Date.now(), member, phase: "resolved", detail });
      const v = Reflect.get(target, prop, recv);
      const member = String(prop);
      if (typeof v === "function") {
        return (...args: unknown[]) => {
          const callDetail = summarize(member, args, target);
          if (member === "saveDiscoveryState" || member === "discoveryState") lastDiscovery = callDetail ?? lastDiscovery;
          record({ at: Date.now(), member, phase: "call", detail: callDetail });
          const out = (v as (...a: unknown[]) => unknown).apply(target, args);
          // The SDK reads the PKCE verifier only on the code-exchange leg, which it enters
          // after RFC 9207 `iss` validation passed (a mismatch throws first): record that.
          const noteIssuerCheck = () => {
            if (member === "codeVerifier") {
              const d = lastDiscovery as { issuer?: string; issParameterSupported?: boolean } | undefined;
              record({ at: Date.now(), member: "issuerCheck", phase: "resolved", detail: { recordedIssuer: d?.issuer, issParameterSupported: d?.issParameterSupported, result: "passed before the code was redeemed" } });
            }
          };
          if (out && typeof (out as Promise<unknown>).then === "function") {
            return (out as Promise<unknown>).then((r) => {
              const d = summarize(member, r, target);
              if (member === "discoveryState") lastDiscovery = d ?? lastDiscovery;
              record({ at: Date.now(), member, phase: "resolved", detail: d });
              noteIssuerCheck();
              return r;
            });
          }
          if (member === "dpop" || member === "clientInformation" || member === "discoveryState") {
            const d = summarize(member, out, target);
            if (member === "discoveryState") lastDiscovery = d ?? lastDiscovery;
            record({ at: Date.now(), member, phase: "resolved", detail: d });
          }
          noteIssuerCheck();
          return out;
        };
      }
      if (SENSITIVE_GETTERS.has(member)) record({ at: Date.now(), member, phase: "get" });
      return v;
    },
  }) as T & { authSteps: () => readonly AuthStep[]; authNote: (member: string, detail?: unknown) => void };
}
