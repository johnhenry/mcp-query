import type { AppSessionState } from "../src/index.js";
export type { AppHost, AppHostOptions, AppSession, AppSessionState, AppStatus, OpenAppOptions } from "../src/index.js";
export interface UseMcpAppResultLike {
  session: import("../src/index.js").AppSession | undefined;
  state: AppSessionState | undefined;
  error: Error | undefined;
}
