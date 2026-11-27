// The callback leg of the browser OAuth flow: hand the authorization response to the SDK and make
// the RFC 9207 issuer check visible in the stepper either way (the SDK only throws on failure;
// the instrumented provider records the pass).

import * as sdk from "@modelcontextprotocol/client";

interface FinishAuthTransport {
  finishAuth(callbackParams: URLSearchParams): Promise<void>;
  finishAuth(code: string, iss?: string): Promise<void>;
}
interface Noting {
  authNote?: (member: string, detail?: unknown) => void;
  discoveryState?: () => unknown;
}

const hasIssuerError = "IssuerMismatchError" in sdk;

/** Read the issuer recorded at discovery (what `iss` must equal). */
function recordedIssuer(provider: Noting): string | undefined {
  try {
    const d = provider.discoveryState?.() as { authorizationServerUrl?: string; authorizationServerMetadata?: { issuer?: string } } | undefined;
    return d?.authorizationServerMetadata?.issuer ?? d?.authorizationServerUrl;
  } catch {
    return undefined;
  }
}

/**
 * Exchange the code. On SDKs that validate `iss` (those exporting `IssuerMismatchError`) the whole
 * callback is passed so the SDK checks `iss` before redeeming the code; on the 2.0.0 floor the
 * code goes in alone and no `iss` check happens (noted in the stepper as such).
 */
export async function completeAuth(transport: FinishAuthTransport, provider: Noting, params: URLSearchParams): Promise<void> {
  const iss = params.get("iss") ?? undefined;
  provider.authNote?.("callbackReceived", { iss: iss && iss.length > 200 ? `${iss.slice(0, 200)}…` : iss, hasCode: params.has("code") });
  const code = params.get("code");
  if (!code) throw new Error("authorization response had no code");
  try {
    if (hasIssuerError) await transport.finishAuth(params);
    else {
      await transport.finishAuth(code);
      provider.authNote?.("issuerCheck", { result: "passed", recordedIssuer: recordedIssuer(provider), reason: "this SDK version does not validate iss" });
    }
  } catch (e) {
    const err = e as { name?: string; kind?: string; expected?: string; received?: string; recordedIssuer?: string; currentIssuer?: string };
    if (err.name === "IssuerMismatchError" || err.kind === "authorization_response") {
      // `received` is attacker-controllable in a mix-up attack: it is shown only here, in a developer
      // debugger, escaped and truncated — never the callback's error/error_description text.
      provider.authNote?.("issuerCheck", {
        result: "failed",
        recordedIssuer: err.expected ?? recordedIssuer(provider),
        received: err.received === undefined ? "(no iss in the response)" : err.received.length > 200 ? `${err.received.slice(0, 200)}…` : err.received,
        reason: "The authorization response's iss did not match the issuer recorded at discovery; the code was not redeemed.",
      });
    } else if (err.name === "AuthorizationServerMismatchError") {
      provider.authNote?.("issuerCheck", {
        result: "failed",
        recordedIssuer: err.recordedIssuer,
        received: err.currentIssuer,
        reason: "Discovery on the callback leg resolved a different authorization server than the one used at redirect time.",
      });
    }
    throw e;
  }
}
