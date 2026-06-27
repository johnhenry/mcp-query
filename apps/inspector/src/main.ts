import "./styles.css";
import "./components/app-shell.js";
import "./components/connections.js";
import "./components/tools.js";
import "./components/resources.js";
import "./components/prompts.js";
import "./components/messages.js";
import "./components/approvals.js";
import "./components/composer.js";
import "./components/cache.js";
import "./components/oauth.js";
import { proxyToken, resumeIfAuthCallback } from "./lib/store.js";

// Resume a browser-side OAuth flow if we're returning from the IdP with ?code=…
void resumeIfAuthCallback();

const app = document.getElementById("app")!;
if (!proxyToken) {
  app.innerHTML = `<div class="banner card" role="alert">
    No <code>proxyToken</code> in the URL. Start the proxy (<code>npm run dev</code>) and open the
    printed <code>http://localhost:5173/?proxyToken=…</code> link.</div>`;
}
app.insertAdjacentHTML("beforeend", "<mcp-app></mcp-app>");

// PWA: register the app-shell service worker in production builds only.
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
