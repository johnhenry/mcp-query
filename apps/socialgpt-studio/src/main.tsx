import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { MCPClient } from "mcp-query";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AppProvider } from "@app-shared";
import { NavProvider } from "./nav.js";
import { App } from "./App.js";
import "./styles.css";
import "./auth.css";

interface AuthStatus {
  authenticated: boolean;
  scope: string | null;
}

// The backend (Deno desktop / Node dev) reverse-proxies "/mcp" with the bearer token,
// and hosts the OAuth flow at "/auth/*". Because the backend, the callback, and the
// browser are co-located in the desktop app, login needs no tunnel.

function Login({ onConnected }: { onConnected: () => void }) {
  const [authorizeUrl, setAuthorizeUrl] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [pastedUrl, setPastedUrl] = useState("");
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearInterval(timer.current), []);

  async function connect() {
    setBusy(true);
    setError(undefined);
    try {
      const res = await fetch("/auth/login", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message ?? "login could not start");
      setAuthorizeUrl(data.authorizeUrl as string);
      try {
        window.open(data.authorizeUrl, "_blank", "noopener,noreferrer");
      } catch {
        /* popup blocked — the manual link below covers it */
      }
      timer.current = window.setInterval(async () => {
        const s = (await fetch("/auth/status").then((r) => r.json()).catch(() => ({ authenticated: false }))) as AuthStatus;
        if (s.authenticated) {
          window.clearInterval(timer.current);
          onConnected();
        }
      }, 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  // Paste-the-URL fallback: if the browser's redirect couldn't reach the app, the user pastes the
  // address it landed on; the backend parses code+state and completes the same exchange. On success
  // the /auth/status poll started in connect() flips to authenticated and calls onConnected().
  async function complete() {
    setError(undefined);
    try {
      const res = await fetch("/auth/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: pastedUrl.trim() }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.message ?? "could not complete sign-in");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-mark">◆</div>
        <h1>SocialGPT Studio</h1>
        <p className="auth-sub">Connect your SocialGPT account to search creators, analyze posts, and track growth.</p>
        <button className="auth-btn" onClick={connect} disabled={busy}>
          {busy ? "Waiting for approval…" : "Connect SocialGPT"}
        </button>
        {authorizeUrl && (
          <p className="auth-hint">
            A sign-in tab should have opened. Didn't see it?{" "}
            <a href={authorizeUrl} target="_blank" rel="noreferrer">Open it manually</a>.
          </p>
        )}
        {authorizeUrl && (
          <div className="auth-paste">
            <label htmlFor="auth-paste-url">
              Browser didn't return you to the app? Paste the address it landed on
              (http://localhost…/auth/callback?…) here:
            </label>
            <input
              id="auth-paste-url"
              type="text"
              placeholder="http://localhost:…/auth/callback?code=…&state=…"
              value={pastedUrl}
              onChange={(e) => setPastedUrl(e.target.value)}
            />
            <button className="auth-btn" onClick={complete} disabled={!pastedUrl.trim()}>
              Complete sign-in
            </button>
          </div>
        )}
        {error && <p className="auth-error">{error}</p>}
        <p className="auth-foot">Sign-in happens on SocialGPT's own page — the app never sees your password.</p>
      </div>
    </div>
  );
}

function Studio({ scope, onReconnect }: { scope: string | null; onReconnect: () => void }) {
  const client = useMemo(
    () =>
      new MCPClient({
        servers: { socialgpt: { transport: () => new StreamableHTTPClientTransport(new URL("/mcp", location.origin)) } },
        clientInfo: { name: "socialgpt-studio", version: "0.0.1" },
      }),
    [],
  );
  useEffect(() => {
    void client.connect();
    return () => void client.close();
  }, [client]);

  const limited = !!scope && !scope.includes("analysis:read:public");

  async function reconnect() {
    await fetch("/auth/logout", { method: "POST" }).catch(() => {});
    onReconnect();
  }

  return (
    <AppProvider client={client}>
      <NavProvider>
        {limited && (
          <div className="scope-banner">
            <span>Limited access — full creator analytics need broader permissions.</span>
            <button onClick={reconnect}>Reconnect for full access</button>
          </div>
        )}
        <App />
      </NavProvider>
    </AppProvider>
  );
}

function Root() {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const check = useCallback(() => {
    void fetch("/auth/status")
      .then((r) => r.json())
      .then((s: AuthStatus) => setStatus(s))
      .catch(() => setStatus({ authenticated: false, scope: null }));
  }, []);
  useEffect(() => check(), [check]);

  if (!status) {
    return (
      <div className="auth-screen">
        <div className="auth-card"><p className="auth-sub">Checking sign-in…</p></div>
      </div>
    );
  }
  if (!status.authenticated) return <Login onConnected={check} />;
  return <Studio scope={status.scope} onReconnect={check} />;
}

createRoot(document.getElementById("app")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
