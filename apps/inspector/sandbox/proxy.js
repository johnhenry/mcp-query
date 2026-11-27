import { startProxy } from "./proxy-lib.js";

const host = new URL(location.href).searchParams.get("host") ?? "";
let hostOrigin = "";
try { hostOrigin = new URL(host).origin; } catch { /* unpinned: dev only */ }
startProxy({ win: window, doc: document, hostOrigin });
