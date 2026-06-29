// Minimal hash-based, state-driven navigation (React Router-free). A single Route union
// drives which screen renders; `useNav()` exposes the current route + a setter that also
// syncs to location.hash so reloads / back-button land on the same screen.
//
// SocialGPT identifies creators by (platform, username) and videos by (platform, post_id),
// with accounts also carrying an account_id — so routes carry those compound keys.

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type Route =
  | { screen: "search" }
  | { screen: "creator"; platform: string; username: string; accountId?: string; name?: string }
  | { screen: "analyze"; kind?: "creator" | "post"; platform?: string; username?: string }
  | { screen: "video"; platform: string; postId: string; title?: string };

export const SERVER = "socialgpt";

interface NavCtx {
  route: Route;
  go: (route: Route) => void;
}

const Ctx = createContext<NavCtx | null>(null);

function parseHash(): Route {
  const params = new URLSearchParams(location.hash.replace(/^#/, ""));
  const screen = params.get("screen");
  const get = (k: string) => params.get(k) ?? undefined;
  switch (screen) {
    case "creator":
      return {
        screen: "creator",
        platform: params.get("platform") ?? "",
        username: params.get("username") ?? "",
        accountId: get("accountId"),
        name: get("name"),
      };
    case "analyze":
      return {
        screen: "analyze",
        kind: (params.get("kind") as "creator" | "post" | null) ?? undefined,
        platform: get("platform"),
        username: get("username"),
      };
    case "video":
      return { screen: "video", platform: params.get("platform") ?? "", postId: params.get("postId") ?? "", title: get("title") };
    case "search":
    default:
      return { screen: "search" };
  }
}

function toHash(route: Route): string {
  const p = new URLSearchParams();
  p.set("screen", route.screen);
  const add = (k: string, v?: string) => v && p.set(k, v);
  if (route.screen === "creator") {
    add("platform", route.platform);
    add("username", route.username);
    add("accountId", route.accountId);
    add("name", route.name);
  } else if (route.screen === "analyze") {
    add("kind", route.kind);
    add("platform", route.platform);
    add("username", route.username);
  } else if (route.screen === "video") {
    add("platform", route.platform);
    add("postId", route.postId);
    add("title", route.title);
  }
  return "#" + p.toString();
}

export function NavProvider({ children }: { children: ReactNode }) {
  const [route, setRoute] = useState<Route>(() => parseHash());

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const go = useCallback((next: Route) => {
    const h = toHash(next);
    if (location.hash !== h) location.hash = h;
    setRoute(next);
  }, []);

  const value = useMemo(() => ({ route, go }), [route, go]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useNav(): NavCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useNav must be used inside <NavProvider>");
  return ctx;
}
