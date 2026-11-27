// @vitest-environment happy-dom
// useSkills / useSkill with an injected fake SDK skills module, so the hooks are
// exercised on every supported SDK (see skills-fake-sdk.test.ts).

import { useState } from "react";
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { MCPClient } from "../src/core/client.js";
import type { SkillsSdk } from "../src/core/skills.js";
import { MockMCPServer } from "../src/testing/mockServer.js";
import { MCPProvider, useSkill, useSkills } from "../src/react/index.js";

afterEach(cleanup);

const URI = "skill://git-commit/SKILL.md";
const ENTRY = { uri: URI, frontmatter: { name: "git-commit", description: "Commits" }, resources: [{ uri: URI, digest: "sha256:aaa", size: 4 }] };

function sdk(state: { fail?: boolean }): () => Promise<SkillsSdk> {
  class SkillsClient {
    async list() {
      if (state.fail) throw new Error("listing failed");
      return { skills: [ENTRY], ttlMs: 60_000, cacheScope: "private" as const };
    }
    async get() {
      return { skill: ENTRY, ttlMs: 60_000, cacheScope: "private" as const };
    }
    async read(skill: { uri: string }) {
      return { uri: skill.uri, bytes: new Uint8Array([1]), text: "the body", verified: true };
    }
  }
  return async () => ({ SkillsClient }) as unknown as SkillsSdk;
}

async function connect(state: { fail?: boolean } = {}) {
  const server = new MockMCPServer({ skills: [{ name: "git-commit", description: "Commits" }] }, { era: "legacy" });
  const client = new MCPClient({ servers: { s: { transport: server.transport } }, skillsSdk: sdk(state) });
  await client.connect();
  return { server, client };
}

function List({ server }: { server?: string }) {
  const { skills, error } = useSkills(server);
  return (
    <div>
      <span data-testid="error">{error?.message ?? ""}</span>
      {skills.map((s) => (
        <p key={`${s.server}:${s.uri}`}>
          {s.server}/{s.frontmatter.name}
        </p>
      ))}
    </div>
  );
}

function One() {
  const { skill, readFile } = useSkill(URI, { server: "s" });
  const [text, setText] = useState("");
  return (
    <div>
      <span data-testid="name">{skill?.frontmatter.name ?? ""}</span>
      <button onClick={() => void readFile().then((f) => setText(f.text ?? ""))}>read</button>
      <span data-testid="text">{text}</span>
    </div>
  );
}

describe("skill hooks with an injected SDK module", () => {
  it("useSkills lists one server and the union", async () => {
    const { server, client } = await connect();
    render(
      <MCPProvider client={client}>
        <List server="s" />
        <List />
      </MCPProvider>,
    );
    await waitFor(() => expect(screen.getAllByText("s/git-commit")).toHaveLength(2));
    await client.close();
    await server.close();
  });

  it("useSkills surfaces a listing failure as error", async () => {
    const { server, client } = await connect({ fail: true });
    render(
      <MCPProvider client={client}>
        <List server="s" />
      </MCPProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("error").textContent).not.toBe(""));
    await client.close();
    await server.close();
  });

  it("useSkill resolves the entry and reads its SKILL.md", async () => {
    const { server, client } = await connect();
    render(
      <MCPProvider client={client}>
        <One />
      </MCPProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("name").textContent).toBe("git-commit"));
    fireEvent.click(screen.getByText("read"));
    await waitFor(() => expect(screen.getByTestId("text").textContent).toBe("the body"));
    await client.close();
    await server.close();
  });
});
