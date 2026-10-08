---
"@johnhenry/mcp-gate": patch
---

`gate.close()` (and `removeUpstream`/`updateUpstream`) now resolve only after every spawned stdio child has actually exited. Declarative `{ command }` upstreams use a transport that, after the SDK's stdin-close / SIGTERM escalation, SIGKILLs a child that is still alive and awaits its exit, so a child that ignores SIGTERM can no longer outlive `close()` (#23).
