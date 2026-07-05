// @vitest-environment happy-dom
// Integration tests for prompt-studio's three feature pillars, driven end-to-end through
// a real MCPClient over MockMCPServer (in-memory transport):
//
//   1. prompts: usePromptList catalogs → usePrompt renders the message array
//   2. completion/complete: the CompletionInput typeahead surfaces server-driven values
//   3. resource templates: useResourceTemplates lists, {var} expansion reads live

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";

afterEach(cleanup);
import { MCPClient } from "@johnhenry/mcpq";
import { MockMCPServer } from "@johnhenry/mcpq/testing";
import { MCPProvider } from "@johnhenry/mcpq/react";
import type { ReactNode } from "react";
import { PromptGallery } from "../src/components/PromptGallery.js";
import { PromptRunner } from "../src/components/PromptRunner.js";
import { TemplateExplorer } from "../src/components/TemplateExplorer.js";
import { CompletionInput } from "../src/components/CompletionInput.js";

function makeServer() {
  return new MockMCPServer({
    prompts: [
      {
        name: "greeting",
        description: "Say hello with a tone",
        get: (args) => ({
          description: "rendered greeting",
          messages: [
            { role: "user", content: { type: "text", text: `Please greet ${args.name ?? "someone"} in a ${args.tone ?? "neutral"} tone.` } },
          ],
        }),
      },
    ],
    resources: [{ uri: "note://static/1", name: "note 1", read: () => ({ text: "the first note" }) }],
    templates: [{ uriTemplate: "note://static/{id}", name: "note by id" }],
    completions: { tone: ["formal", "casual", "pirate"], id: ["1", "2", "3"] },
  });
}

async function withClient(ui: (client: MCPClient) => ReactNode) {
  const mock = makeServer();
  const client = new MCPClient({ servers: { everything: { transport: mock.transport } } });
  await client.connect();
  const utils = render(<MCPProvider client={client}>{ui(client)}</MCPProvider>);
  return { mock, client, utils };
}

describe("prompt gallery + runner", () => {
  it("catalogs prompts and renders the message transcript on submit", async () => {
    const { client } = await withClient(() => (
      <PromptRunner server="everything" name="greeting" onBack={() => {}} />
    ));

    await waitFor(() => expect(screen.getByText(/Say hello with a tone/)).toBeDefined());

    fireEvent.submit(document.querySelector("form")!);
    await waitFor(() => expect(screen.getByText(/Please greet someone in a neutral tone/)).toBeDefined());

    await client.close();
  });

  it("lists prompts as cards", async () => {
    let picked = "";
    const { client } = await withClient(() => <PromptGallery server="everything" onPick={(n) => (picked = n)} />);
    await waitFor(() => expect(screen.getByText("greeting")).toBeDefined());
    fireEvent.click(screen.getByText("greeting"));
    expect(picked).toBe("greeting");
    await client.close();
  });
});

describe("completion typeahead", () => {
  it("surfaces server-driven completion values", async () => {
    let value = "";
    const { client, utils } = await withClient(() => (
      <CompletionInput
        server="everything"
        refFor={{ type: "ref/prompt", name: "greeting" }}
        argName="tone"
        value=""
        onChange={(v) => (value = v)}
      />
    ));

    const input = utils.container.querySelector("input")!;
    fireEvent.focus(input);
    // Debounced complete() fires after 150ms.
    await waitFor(() => expect(screen.getByText("pirate")).toBeDefined(), { timeout: 3000 });
    fireEvent.mouseDown(screen.getByText("pirate"));
    expect(value).toBe("pirate");

    await client.close();
  });
});

describe("template explorer", () => {
  it("lists templates, expands {id}, and reads the resource", async () => {
    const { client } = await withClient(() => <TemplateExplorer server="everything" />);

    await waitFor(() => expect(screen.getByText("note by id")).toBeDefined());
    fireEvent.click(screen.getByText("note by id"));

    const input = await waitFor(() => document.querySelector(".template-reader input")!);
    fireEvent.change(input, { target: { value: "1" } });
    fireEvent.submit(document.querySelector(".template-reader form")!);

    await waitFor(() => expect(screen.getByText(/the first note/)).toBeDefined(), { timeout: 3000 });
    // Subscribe-capable server → the read is protocol-subscribed for live updates.
    await waitFor(() => expect(screen.getByText("subscribed")).toBeDefined());

    await client.close();
  });
});
