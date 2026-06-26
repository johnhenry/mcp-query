import { createContext, useContext, type ReactNode } from "react";
import type { MCPClient } from "../core/client.js";

const Ctx = createContext<MCPClient | null>(null);

export function MCPProvider({ client, children }: { client: MCPClient; children: ReactNode }) {
  return <Ctx.Provider value={client}>{children}</Ctx.Provider>;
}

export function useMCPClient(): MCPClient {
  const c = useContext(Ctx);
  if (!c) throw new Error("useMCPClient must be used within <MCPProvider>");
  return c;
}
