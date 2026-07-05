# Prompt Studio

**Prompts as a product surface** — browse, fill, and *run* server prompts with live
server-driven argument autocompletion, expand resource templates into parameterized live
reads, and call tools through codegen-typed hooks.

![prompt-studio](screenshots/runner.png)

Every other app treats prompts as a list; this one treats them as the product. It exercises
the mcp-query features no other app touches:

| Feature | Where |
|---|---|
| `usePrompt` — prompts/get, rendered as a chat transcript | `src/components/PromptRunner.tsx` |
| `completion/complete` typeahead, **including dependent completions** via `context.arguments` (pick `department: Engineering` and the `name` argument narrows to that department's people) | `src/components/CompletionInput.tsx` |
| `useResourceTemplates` + RFC-6570 `{var}` expansion into a subscribed `useResource` read | `src/components/TemplateExplorer.tsx` |
| Codegen loop: `npm run codegen` emits `src/mcp.gen.ts`; `createTypedHooks<GeneratedToolMap>` makes tool calls compile-time-typed | `src/components/TypedPlayground.tsx` |
| `persistCache` — the catalog hydrates instantly from localStorage on reload | `src/main.tsx` |

## Run

```bash
npm run dev -w @mcp-query/prompt-studio
# open the printed http://localhost:5179/?proxyToken=…&proxyPort=6286 URL
```

The dev script runs the shared WS proxy (`apps/shared`) alongside Vite; the proxy spawns
`@modelcontextprotocol/server-everything` over stdio — it ships prompts with completable
arguments (`completable-prompt`), resource templates, and the `completions` capability, so
the whole app works offline.

## Regenerate the typed map

```bash
npm run codegen -w @mcp-query/prompt-studio   # re-emits src/mcp.gen.ts from the live server
```

## Tests

`npm test -w @mcp-query/prompt-studio` — integration tests drive the gallery, runner,
typeahead, and template reader through a real `MCPClient` against `MockMCPServer`
(in-memory transport), including the completion round-trip.
