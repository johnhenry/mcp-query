import "./styles.css";
import "./components/app-shell.js";
import "./components/connections.js";
import "./components/tools.js";
import "./components/resources.js";
import "./components/prompts.js";
import "./components/messages.js";
import { proxyToken } from "./lib/store.js";

const app = document.getElementById("app")!;
if (!proxyToken) {
  app.innerHTML = `<div class="banner card" role="alert">
    No <code>proxyToken</code> in the URL. Start the proxy (<code>npm run dev</code>) and open the
    printed <code>http://localhost:5173/?proxyToken=…</code> link.</div>`;
}
app.insertAdjacentHTML("beforeend", "<mcp-app></mcp-app>");
