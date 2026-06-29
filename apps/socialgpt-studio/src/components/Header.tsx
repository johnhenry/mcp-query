import { useServerState, useToolResult } from "mcp-query/react";
import { SERVER, useNav, type Route } from "../nav.js";
import { budget } from "../lib/rateBudget.js";
import { firstString, unwrapResult } from "../lib/format.js";
import { Pill } from "./States.js";

const TABS: Array<{ label: string; route: Route }> = [
  { label: "Search", route: { screen: "search" } },
  { label: "Analyze", route: { screen: "analyze" } },
];

export function Header() {
  const { route, go } = useNav();
  const server = useServerState(SERVER);

  // whoami + server_info — read once, cached, never auto-refetched.
  const who = useToolResult("whoami", {}, { server: SERVER, skip: !server.isReady });
  const info = useToolResult("server_info", {}, { server: SERVER, skip: !server.isReady });

  const whoData = who.data ? (unwrapResult(who.data) as Record<string, unknown>) : undefined;
  const infoData = info.data ? (unwrapResult(info.data) as Record<string, unknown>) : undefined;

  const userLabel = whoData
    ? firstString(whoData, ["name", "username", "email", "user", "handle", "actor_type", "user_id", "id"]) ??
      "authenticated"
    : undefined;
  const serverLabel = infoData
    ? firstString(infoData, ["name", "server", "title"]) ?? "SocialGPT"
    : "SocialGPT";

  const b = budget();
  const budgetTone = b.remaining === 0 ? "bad" : b.remaining <= 2 ? "warn" : "good";

  return (
    <header className="app-header">
      <div className="brand">
        <span className="logo" aria-hidden>◈</span>
        <div>
          <h1>SocialGPT Studio</h1>
          <p className="tagline">{serverLabel} · creator analytics</p>
        </div>
      </div>

      <nav className="tabs">
        {TABS.map((t) => (
          <button
            key={t.label}
            type="button"
            className={`tab ${route.screen === t.route.screen ? "active" : ""}`}
            onClick={() => go(t.route)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <div className="status">
        <ConnPill state={server.state} />
        {userLabel && <Pill tone="neutral">{userLabel}</Pill>}
        <Pill tone={budgetTone} aria-label="analysis budget">
          {b.remaining}/{b.limit} analyses/hr
        </Pill>
      </div>
    </header>
  );
}

function ConnPill({ state }: { state: string }) {
  const tone =
    state === "ready" ? "good" : state === "connecting" || state === "reconnecting" ? "warn" : "bad";
  return <Pill tone={tone}>{state}</Pill>;
}
