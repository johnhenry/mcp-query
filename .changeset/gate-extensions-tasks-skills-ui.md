---
"@johnhenry/mcp-gate": minor
---

Gate: extensions (#82 items 3, 4, 5). New `extensions` config (allow / deny / opt-in `passthrough` of unknown extension methods / `tasksSecret`). Tasks: `redact` scrubs a completed task's inlined `result`, `inputRequests`, `error` and `statusMessage` but never ids; URL-mode elicitations inside a task obey `urlElicitation` (now always enforced); `tasks/update` answers go through `answerPolicy` and `redact`; polls, answers and cancels are policy-checked and audited as `kind: "task"`. Skills: new `policy.skills` allow / deny / approve rules for whole skills (and `policySkillFilter`). **Behaviour change:** `redact` no longer scrubs skill file text (it used to, marking the file `verified: false`); a skill's digest covers its bytes, so the gate never rewrites a skill. MCP Apps: the gate declares the UI extension to upstreams unless `extensions.deny` lists it, and hands UI metadata only to consumers that declared it.
