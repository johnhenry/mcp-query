import { Reactive, esc } from "../lib/reactive.js";
import { hub, authProviders, reauthServer } from "../lib/store.js";

// OAuth debugger — a step-through view of the browser-side OAuth handshake for servers
// connected in "direct" mode. Each step (client registration, PKCE, redirect, token
// read/write) is recorded by instrumentAuthProvider with secrets redacted.

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
      .map(([name, provider]) => {
        const authorized = !!provider.tokens();
        const steps = provider.authSteps();
        return `<section class="card oauth">
          <h3>${esc(name)} <span class="state ${authorized ? "state-ready" : "state-failed"}">${authorized ? "authorized" : "no token"}</span></h3>
          <div class="row">
            <button data-reauth="${esc(name)}">re-authorize</button>
            <button data-clear="${esc(name)}">clear credentials</button>
          </div>
          <ol class="timeline" role="list">
            ${steps.length ? steps.map((s) => `<li><code>${esc(s.member)}</code> <span class="muted">${esc(s.phase)}</span>${s.detail !== undefined ? ` — <span class="muted">${esc(JSON.stringify(s.detail))}</span>` : ""}</li>`).join("") : '<li class="muted">no steps recorded yet</li>'}
          </ol>
        </section>`;
      })
      .join("");

    this.querySelectorAll<HTMLButtonElement>("[data-reauth]").forEach((b) => (b.onclick = () => void reauthServer(b.dataset.reauth!)));
    this.querySelectorAll<HTMLButtonElement>("[data-clear]").forEach(
      (b) => (b.onclick = () => { authProviders.get(b.dataset.clear!)?.invalidateCredentials?.("all"); this.update(); }),
    );
  }
}
customElements.define("mcp-oauth", OAuth);
