// @vitest-environment happy-dom
// useSkills / useSkill against MockMCPServer's skills fixture. Needs the SDK's
// ext/skills (>= 2.4.0); skipped, with the reason in the name, on older SDKs.

import { useState } from "react";
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { MCPClient } from "../src/core/client.js";
import { skillsSdkAvailable, SKILLS_MIN_SDK } from "../src/core/skills.js";
import { MockMCPServer } from "../src/testing/mockServer.js";
import { MCPProvider, useSkill, useSkills } from "../src/react/index.js";

const hasSdk = await skillsSdkAvailable();
afterEach(cleanup);

function List({ server }: { server?: string }) {
  const { skills, isLoading, error } = useSkills(server);
  return (
    <div>
      <span data-testid="loading">{String(isLoading)}</span>
      <span data-testid="error">{error?.message ?? ""}</span>
      <ul>
        {skills.map((s) => (
          <li key={`${s.server}:${s.uri}`}>
            {s.server}/{s.frontmatter.name}
          </li>
        ))}
      </ul>
    </div>
  );
}

function One({ uri, server }: { uri: string; server?: string }) {
  const { skill, readFile } = useSkill(uri, { server });
  const [text, setText] = useState("");
  return (
    <div>
      <span data-testid="name">{skill?.frontmatter.name ?? ""}</span>
      <button onClick={() => void readFile().then((f) => setText(f.text ?? ""))}>read</button>
      <span data-testid="text">{text}</span>
    </div>
  );
}

describe.skipIf(!hasSdk)(`skill hooks${hasSdk ? "" : ` — SKIPPED: needs @modelcontextprotocol/client >= ${SKILLS_MIN_SDK}`}`, () => {
  it("useSkills lists skills and re-renders after a resources list_changed", async () => {
    const server = new MockMCPServer({ skills: [{ name: "git-commit", description: "Commits" }] }, { era: "legacy" });
    const client = new MCPClient({ servers: { s: { transport: server.transport } } });
    await client.connect();
    render(
      <MCPProvider client={client}>
        <List server="s" />
      </MCPProvider>,
    );
    await waitFor(() => expect(screen.getByText("s/git-commit")).toBeTruthy());

    server.spec.skills = [{ name: "git-commit", description: "Commits" }, { name: "pdf", description: "PDFs" }];
    await server.notifyResourceListChanged();
    await waitFor(() => expect(screen.getByText("s/pdf")).toBeTruthy(), { timeout: 5000 });

    await client.close();
    await server.close();
  });

  it("useSkills() without a server unions skills-capable servers", async () => {
    const a = new MockMCPServer({ skills: [{ name: "one", description: "1" }] }, { era: "legacy" });
    const b = new MockMCPServer({ skills: [{ name: "two", description: "2" }] }, { era: "legacy" });
    const client = new MCPClient({ servers: { a: { transport: a.transport }, b: { transport: b.transport } } });
    await client.connect();
    render(
      <MCPProvider client={client}>
        <List />
      </MCPProvider>,
    );
    await waitFor(() => expect(screen.getByText("a/one")).toBeTruthy());
    await waitFor(() => expect(screen.getByText("b/two")).toBeTruthy());
    await client.close();
    await a.close();
    await b.close();
  });

  it("useSkills surfaces a failure as `error` instead of throwing", async () => {
    const server = new MockMCPServer({ skills: [{ name: "x", description: "x" }] }, { era: "legacy" });
    const client = new MCPClient({
      servers: { s: { transport: server.transport } },
      skillsSdk: () => Promise.reject(new Error("no sdk")),
    });
    await client.connect();
    render(
      <MCPProvider client={client}>
        <List server="s" />
      </MCPProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("error").textContent).toContain(`>= ${SKILLS_MIN_SDK}`));
    await client.close();
    await server.close();
  });

  it("useSkill resolves a skill (by server, or from the catalog) and reads its verified SKILL.md", async () => {
    const server = new MockMCPServer({ skills: [{ name: "git-commit", description: "Commits", body: "Be brief." }] }, { era: "legacy" });
    const client = new MCPClient({ servers: { s: { transport: server.transport } } });
    await client.connect();
    for (const props of [{ uri: "skill://git-commit/SKILL.md", server: "s" }, { uri: "skill://git-commit/SKILL.md" }]) {
      const view = render(
        <MCPProvider client={client}>
          <One {...props} />
        </MCPProvider>,
      );
      await waitFor(() => expect(screen.getByTestId("name").textContent).toBe("git-commit"));
      fireEvent.click(screen.getByText("read"));
      await waitFor(() => expect(screen.getByTestId("text").textContent).toContain("Be brief."));
      view.unmount();
    }
    await client.close();
    await server.close();
  });
});
