// Multi-round-trip (MRTR, SEP-2322) pass-through helpers. A caller that wants to SEE an
// upstream's `input_required` result (instead of letting the SDK's driver answer it with the
// host handlers) passes a `ToolInteraction` on the call; the gateway uses this to forward
// the round to its own consumer and to route the consumer's retry back to the same call.

/** MRTR retry params for one call: what the previous `input_required` round asked for, answered. */
export interface ToolInteraction {
  /** The consumer's answers, keyed like the `inputRequests` of the previous round. */
  inputResponses?: Record<string, unknown>;
  /** The previous round's opaque `requestState`, echoed byte-for-byte. */
  requestState?: string;
}

/** The neutral shape of an `input_required` result as the SDK hands it back (manual mode). */
export interface InputRequiredShape {
  resultType: "input_required";
  inputRequests?: Record<string, { method: string; params?: Record<string, unknown> }>;
  requestState?: string;
  [key: string]: unknown;
}

/** True for an interim `input_required` result — never cache one. */
export function isInputRequiredResult(value: unknown): value is InputRequiredShape {
  return typeof value === "object" && value !== null && (value as { resultType?: unknown }).resultType === "input_required";
}

/** What an audit entry records about an MRTR hop (no payloads — methods, keys and URL hosts only). */
export interface AuditInteraction {
  /** "request": this call returned `input_required`. "response": this call carried `inputResponses`/`requestState`. */
  phase: "request" | "response";
  /** `request`: the embedded request methods, e.g. `elicitation/create`. */
  methods?: string[];
  /** `request`: hosts of URL-mode elicitations. */
  urlHosts?: string[];
}

/** The host of a URL-mode elicitation's `url`, lowercased; undefined if it does not parse. */
export function urlHost(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  try {
    return new URL(url).hostname.toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

/** Describe an MRTR hop for the audit trail; undefined when the call was not part of one. */
export function describeInteraction(result: unknown, sent: ToolInteraction | undefined): AuditInteraction | undefined {
  if (isInputRequiredResult(result)) {
    const reqs = Object.values(result.inputRequests ?? {});
    const hosts = reqs
      .filter((r) => r.method === "elicitation/create" && r.params?.mode === "url")
      .map((r) => urlHost(r.params?.url) ?? "(unparseable)");
    return { phase: "request", methods: reqs.map((r) => r.method), ...(hosts.length ? { urlHosts: hosts } : {}) };
  }
  if (sent && (sent.inputResponses !== undefined || sent.requestState !== undefined)) return { phase: "response" };
  return undefined;
}

/** Wire params for a retry: `inputResponses` + `requestState`, only the ones present. */
export function mrtrParams(i: ToolInteraction | undefined): { inputResponses?: Record<string, unknown>; requestState?: string } {
  return {
    ...(i?.inputResponses !== undefined ? { inputResponses: i.inputResponses } : {}),
    ...(i?.requestState !== undefined ? { requestState: i.requestState } : {}),
  };
}
