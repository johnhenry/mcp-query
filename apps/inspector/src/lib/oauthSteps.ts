// Turns the raw step log recorded by instrumentAuthProvider (+ notes this app adds) into the
// plain-language view the OAuth debugger shows: which registration path was taken and why, the
// issuer check (expected vs received) and DPoP on/off. Pure functions, no DOM, so they are tested
// directly. Nothing secret is ever in a step (tokens/verifiers are redacted at the source); the
// only identifiers shown are issuers, client ids and the DPoP key thumbprint (public by design).

import type { AuthStep } from "@johnhenry/mcp-query";

const KEY = (server: string) => `mcp-oauth-steps:${server}`;
const MAX = 200;

/** The page navigates away to the authorization server, so keep the log across the redirect. */
export function loadSteps(server: string): AuthStep[] {
  try {
    const raw = sessionStorage.getItem(KEY(server));
    return raw ? (JSON.parse(raw) as AuthStep[]) : [];
  } catch {
    return [];
  }
}
export function appendStep(server: string, step: AuthStep): void {
  try {
    const all = loadSteps(server);
    all.push(step);
    sessionStorage.setItem(KEY(server), JSON.stringify(all.slice(-MAX)));
  } catch {
    /* storage unavailable or full: the live in-memory log still works */
  }
}
export function clearSteps(server: string): void {
  try {
    sessionStorage.removeItem(KEY(server));
  } catch {
    /* ignore */
  }
}

export interface RegistrationView {
  /** "pending" until a client has been registered or selected. */
  method: "cimd" | "dcr" | "pending";
  clientId?: string;
  /** Plain-language reason for the path taken. */
  why: string;
  /** What the authorization server offered, once discovery has run. */
  offers?: { cimd: boolean; dcr: boolean };
}
export interface IssuerView {
  /** "not checked" until the callback has come back. */
  result: "passed" | "failed" | "not checked";
  expected?: string;
  received?: string;
  /** Short plain explanation. */
  detail: string;
}
export interface DpopView {
  enabled: boolean;
  thumbprint?: string;
  alg?: string;
  detail: string;
}
export interface AuthView {
  registration: RegistrationView;
  issuer: IssuerView;
  dpop: DpopView;
}

type D = Record<string, unknown>;
const obj = (v: unknown): D => (v && typeof v === "object" ? (v as D) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const last = (steps: readonly AuthStep[], pred: (s: AuthStep) => boolean): AuthStep | undefined => {
  for (let i = steps.length - 1; i >= 0; i--) if (pred(steps[i]!)) return steps[i];
  return undefined;
};
const trunc = (s: string | undefined, n = 200): string | undefined => (s && s.length > n ? `${s.slice(0, n)}…` : s);

export function summarizeAuth(steps: readonly AuthStep[]): AuthView {
  // --- registration: CIMD vs DCR, and why ---
  const offer = last(steps, (s) => s.member === "clientMetadataUrl" && s.detail !== undefined);
  const offerD = obj(offer?.detail);
  const disc = last(steps, (s) => /^(saveDiscoveryState|discoveryState)$/.test(s.member) && s.detail !== undefined && !Array.isArray(s.detail));
  const discD = obj(disc?.detail);
  const hasDisc = disc !== undefined;
  const offers = hasDisc ? { cimd: discD.cimdSupported === true, dcr: discD.dcrAvailable === true } : undefined;
  const reg = last(steps, (s) => /^(saveClientInformation|clientInformation)$/.test(s.member) && !!obj(s.detail).registration);
  const regD = obj(reg?.detail);
  let registration: RegistrationView;
  if (reg) {
    const method = regD.registration === "cimd" ? "cimd" : "dcr";
    let why: string;
    if (method === "cimd") {
      why = "The authorization server advertises Client ID Metadata Document support and the inspector's document was offered, so the document URL is the client id (no registration request).";
    } else if (offerD.offered === false && str(offerD.reason)) {
      why = `Dynamic client registration: the metadata document was not used — ${str(offerD.reason)}.`;
    } else if (offers && !offers.cimd) {
      why = "Dynamic client registration: the authorization server does not advertise Client ID Metadata Document support.";
    } else {
      why = "Dynamic client registration was used for this authorization server.";
    }
    registration = { method, clientId: str(regD.clientId), why, offers };
  } else {
    const pre = offerD.offered === true
      ? "The metadata document checks out and will be used if the authorization server supports it; otherwise the client registers dynamically."
      : str(offerD.reason)
        ? `The metadata document will not be used — ${str(offerD.reason)}.`
        : "No client registered yet.";
    registration = { method: "pending", why: pre, offers };
  }

  // --- issuer check (RFC 9207) ---
  const cb = last(steps, (s) => s.member === "callbackReceived");
  const received = str(obj(cb?.detail).iss);
  const check = last(steps, (s) => s.member === "issuerCheck");
  const checkD = obj(check?.detail);
  let issuer: IssuerView;
  if (check) {
    const failed = checkD.result === "failed";
    issuer = {
      result: failed ? "failed" : "passed",
      expected: trunc(str(checkD.recordedIssuer) ?? str(checkD.expected)),
      received: trunc(failed ? str(checkD.received) : received),
      detail: failed
        ? str(checkD.reason) ?? "The authorization response's iss did not match the issuer recorded at discovery; the code was NOT redeemed."
        : received
          ? "The authorization response's iss matched the issuer recorded at discovery, before the code was redeemed."
          : checkD.issParameterSupported === false
            ? "The server does not advertise iss in responses; none was required."
            : "No iss was needed; the check passed before the code was redeemed.",
    };
  } else {
    issuer = {
      result: "not checked",
      expected: trunc(str(obj(disc?.detail).issuer)),
      detail: "Runs when the browser returns from the authorization server with a code.",
    };
  }

  // --- DPoP ---
  const dp = last(steps, (s) => s.member === "dpop" && !!obj(s.detail).thumbprint);
  const dpD = obj(dp?.detail);
  const dpop: DpopView = dp
    ? { enabled: true, thumbprint: str(dpD.thumbprint), alg: str(dpD.alg), detail: "Tokens are bound to this key (key thumbprint shown; the key itself is never recorded)." }
    : { enabled: false, detail: "Off: this provider does not send DPoP proofs, so tokens are ordinary bearer tokens." };

  return { registration, issuer, dpop };
}

/** Plain labels for the raw timeline rows. */
const LABELS: Record<string, string> = {
  redirectUrl: "Redirect URI read",
  clientMetadata: "Client metadata read",
  clientMetadataUrl: "Client ID Metadata Document check",
  clientInformation: "Stored client looked up",
  saveClientInformation: "Client saved",
  saveDiscoveryState: "Discovery saved (authorization server and what it offers)",
  discoveryState: "Discovery loaded",
  saveCodeVerifier: "PKCE verifier saved (value hidden)",
  codeVerifier: "PKCE verifier read (value hidden)",
  redirectToAuthorization: "Sent to the authorization server",
  callbackReceived: "Returned from the authorization server",
  issuerCheck: "Issuer check (iss)",
  saveTokens: "Tokens saved (values hidden)",
  tokens: "Tokens read (values hidden)",
  invalidateCredentials: "Credentials cleared",
  dpop: "DPoP key",
  state: "State value generated",
};
export function labelFor(member: string): string {
  const base = member.includes(".") ? member.slice(member.lastIndexOf(".") + 1) : member;
  return LABELS[base] ?? base;
}
