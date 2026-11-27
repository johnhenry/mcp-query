import { Reactive, esc } from "../lib/reactive.js";
import { hub, authProviders, reauthServer } from "../lib/store.js";
import { hasStoredTokens } from "../lib/oauth.js";
import { clearSteps, labelFor, loadSteps, summarizeAuth } from "../lib/oauthSteps.js";

// OAuth debugger — a step-through view of the browser-side OAuth handshake for servers
// connected in "direct" mode. Each step (client registration, PKCE, redirect, token
// read/write) is recorded by instrumentAuthProvider with secrets redacted; a plain-language
// summary on top says which registration path was used and why, how the issuer check came out,
// and whether DPoP is on. The step log is kept across the redirect to the authorization server.

const BADGE: Record<string, string> = { passed: "state-ready", failed: "state-failed", "not checked": "state-connecting" };

export class OAuth extends Reactive {
  connectedCallback(): void {
    this.track(hub.subscribe); // live: auth steps arrive as devtools `auth` events
    super.connectedCallback();
  }

  protected update(): void {
    const servers = [...authProviders.entries()];
    if (servers.length === 0) {
      this.innerHTML = `<div class="card"><p class="muted">No OAuth sessions. Connect an http/sse server with
        <b>direct (browser OAuth)</b> checked to debug its authorization flow here.</p>
        <p class="muted">Direct mode needs the server (and its token endpoint) to allow this origin via CORS.</p></div>`;
      return;
    }

    this.innerHTML = servers
      .map(([name]) => {
        const authorized = hasStoredTokens(name);
        const steps = loadSteps(name).filter((s) => s.member !== "prepare"); // "prepare" is plumbing, its outcome is the document-check note
        const v = summarizeAuth(steps);
        const regLabel = v.registration.method === "cimd" ? "Client ID Metadata Document" : v.registration.method === "dcr" ? "Dynamic client registration" : "not registered yet";
        const offers = v.registration.offers
          ? `server offers: ${v.registration.offers.cimd ? "metadata document" : "no metadata document"}, ${v.registration.offers.dcr ? "dynamic registration" : "no dynamic registration"}`
          : "";
        return `<section class="card oauth" data-server="${esc(name)}">
          <h3>${esc(name)} <span class="state ${authorized ? "state-ready" : "state-failed"}">${authorized ? "authorized" : "no token"}</span></h3>
          <div class="row">
            <button data-reauth="${esc(name)}">re-authorize</button>
            <button data-clear="${esc(name)}">clear credentials</button>
          </div>
          <dl class="oauth-summary" aria-label="OAuth summary">
            <dt>Client registration</dt>
            <dd data-field="registration"><b>${esc(regLabel)}</b>${v.registration.clientId ? ` <code>${esc(v.registration.clientId)}</code>` : ""}
              <div class="muted">${esc(v.registration.why)}${offers ? ` (${esc(offers)})` : ""}</div></dd>
            <dt>Issuer check (RFC 9207)</dt>
            <dd data-field="issuer"><span class="state ${BADGE[v.issuer.result]}">${esc(v.issuer.result)}</span>
              ${v.issuer.expected ? ` expected <code>${esc(v.issuer.expected)}</code>` : ""}${v.issuer.received ? ` received <code>${esc(v.issuer.received)}</code>` : ""}
              <div class="muted">${esc(v.issuer.detail)}</div></dd>
            <dt>DPoP</dt>
            <dd data-field="dpop"><span class="state ${v.dpop.enabled ? "state-ready" : "state-connecting"}">${v.dpop.enabled ? "on" : "off"}</span>
              ${v.dpop.thumbprint ? ` key thumbprint <code>${esc(v.dpop.thumbprint)}</code>${v.dpop.alg ? ` (${esc(v.dpop.alg)})` : ""}` : ""}
              <div class="muted">${esc(v.dpop.detail)}</div></dd>
          </dl>
          <details class="oauth-steps"><summary>All recorded steps (${steps.length})</summary>
          <ol class="timeline" role="list">
            ${steps.length ? steps.map((s) => `<li><span>${esc(labelFor(s.member))}</span> <code class="muted">${esc(s.member)}</code> <span class="muted">${esc(s.phase)}</span>${s.detail !== undefined ? ` — <span class="muted">${esc(JSON.stringify(s.detail))}</span>` : ""}</li>`).join("") : '<li class="muted">no steps recorded yet</li>'}
          </ol></details>
        </section>`;
      })
      .join("");

    this.querySelectorAll<HTMLButtonElement>("[data-reauth]").forEach((b) => (b.onclick = () => void reauthServer(b.dataset.reauth!)));
    this.querySelectorAll<HTMLButtonElement>("[data-clear]").forEach(
      (b) => (b.onclick = () => { authProviders.get(b.dataset.clear!)?.invalidateCredentials?.("all"); clearSteps(b.dataset.clear!); this.update(); }),
    );
  }
}
customElements.define("mcp-oauth", OAuth);
