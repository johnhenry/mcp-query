// MCP Console (Web Components). Auto-generates an operator UI from any MCP server's
// capability discovery. The shared WS proxy bridges stdio/http/sse servers; direct
// http/sse servers run browser-side OAuth.

import "./styles.css";
import "./components/console-app.js";
import { resumeIfAuthCallback } from "./lib/store.js";

// Resume a browser-side OAuth flow if we're returning from the IdP with ?code=…
void resumeIfAuthCallback();

const app = document.getElementById("app")!;
app.innerHTML = "<console-app></console-app>";
