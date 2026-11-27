---
"@johnhenry/mcp-record": patch
---

Fix `replayTransport` on a 2026-07-28 (modern-era) cassette: the replay cursor was rebuilt for every HTTP request, so repeated identical calls (for example `tasks/get` polling) always returned the first recorded result instead of the recorded sequence. The cursor now lives for the whole connection. Surfaced by running the suite on an SDK that lets `tasks/*` through.
