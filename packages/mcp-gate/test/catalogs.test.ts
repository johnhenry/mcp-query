// #90: the gate's policy, redaction and audit now see prompts/get, the skills calls and catalog views.
import { afterEach, describe, expect, it } from "vitest";
import { MockMCPServer } from "@johnhenry/mcp-query/testing";
import type { CallAuditEntry } from "@johnhenry/mcp-query";
import { createGateClient, type GateClient } from "../src/index.browser.js";
import { compilePolicy } from "../src/config.js";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

const ENTRY = {
  uri: "skill://git-commit/SKILL.md",
  frontmatter: { name: "git-commit", description: "Commits" },
  resources: [{ uri: "skill://git-commit/SKILL.md", digest: "sha256:aaa", size: 10 }],
};
// The lockfile's SDK predates `ext/skills`: inject a fake skills module into the gate's client (same idea as
// mcp-query's skills-fake-sdk.test.ts, which does it through `MCPClientConfig.skillsSdk`).
const fakeSkillsSdk = async () => {
  class SkillsClient {
    async list() {
      return { skills: [ENTRY], ttlMs: 0, cacheScope: "private" as const };
    }
    async get() {
      return { skill: ENTRY, ttlMs: 0, cacheScope: "private" as const };
    }
    async read(skill: { uri: string }, ref?: string) {
      return { uri: ref ?? skill.uri, bytes: new TextEncoder().encode("mail a@b.com"), text: "mail a@b.com", verified: true };
    }
  }
  return { SkillsClient } as never;
};

async function gate(config: Partial<Parameters<typeof createGateClient>[0]> = {}) {
  const mock = new MockMCPServer(
    {
      tools: [
        { name: "read_x", handler: () => ({ content: [{ type: "text", text: "ok" }] }) },
        { name: "secret_op", handler: () => ({ content: [{ type: "text", text: "s" }] }) },
      ],
      prompts: [
        { name: "greet", get: (a) => ({ messages: [{ role: "user", content: { type: "text", text: `hi ${a.who} a@b.com` } }] }) },
        { name: "private_prompt", get: () => ({ messages: [] }) },
      ],
      skills: [{ name: "git-commit", description: "Commits" }],
    },
    { era: "legacy" },
  );
  const audit: CallAuditEntry[] = [];
  const g: GateClient = await createGateClient({ upstreams: { up: { transport: mock.transport } }, audit: (e) => audit.push(e), ...config });
  (g.client as unknown as { skills: { host: { loader: unknown } } }).skills.host.loader = fakeSkillsSdk;
  closers.push(() => g.close(), () => mock.close());
  return { g, audit, mock };
}

describe("mcp-gate sees prompts/get, skills and catalogs", () => {
  it("audits prompts/get and each skills call", async () => {
    const { g, audit } = await gate();
    await g.client.getPrompt("greet", { who: "ann" }, "up");
    await g.client.listSkills("up");
    const skill = await g.client.getSkill(ENTRY.uri, "up");
    await g.client.readSkillFile(skill);
    const rows = audit.map((e) => [e.kind, e.server, e.target, e.outcome]);
    expect(rows).toContainEqual(["prompt", "up", "greet", "ok"]);
    expect(rows).toContainEqual(["skill", "up", "skills", "ok"]);
    expect(rows).toContainEqual(["skill", "up", ENTRY.uri, "ok"]);
    expect(audit.filter((e) => e.kind === "list").map((e) => e.target)).toEqual(expect.arrayContaining(["prompts", "tools"])); // connect-time catalog views
  });

  it("a declarative deny glob denies prompts/get (audited denied), consistent with hiding it from the list", async () => {
    const { g, audit } = await gate({ policy: { deny: ["up.private_*", "up.secret_*"] } });
    expect(g.client.listPrompts("up").map((p) => p.name)).toEqual(["greet"]);
    await expect(g.client.getPrompt("private_prompt", {}, "up")).rejects.toMatchObject({ code: -32003 });
    expect(audit.find((e) => e.kind === "prompt" && e.target === "private_prompt")?.outcome).toBe("denied");
    await g.client.getPrompt("greet", {}, "up");
    // library mode now applies the same discovery filter as the gateway
    expect(g.client.listTools("up").map((t) => t.name)).toEqual(["read_x"]);
  });

  it("an allow list that names only tools does not take down the catalog views or skills", async () => {
    const { g } = await gate({ policy: { allow: ["up.read_*"] } });
    expect(g.client.listTools("up").map((t) => t.name)).toEqual(["read_x"]);
    expect(await g.client.listSkills("up")).toHaveLength(1);
  });

  it("a function policy receives list / prompt / skill requests and can deny skills", async () => {
    const kinds: string[] = [];
    const { g, audit } = await gate({
      policy: (req) => {
        kinds.push(req.kind);
        return req.kind === "skill" ? "deny" : "allow";
      },
    });
    await g.client.getPrompt("greet", {}, "up");
    await expect(g.client.listSkills("up")).rejects.toMatchObject({ code: -32003 });
    await expect(g.client.getSkill(ENTRY.uri, "up")).rejects.toMatchObject({ code: -32003 });
    expect([...new Set(kinds)].sort()).toEqual(["list", "prompt", "skill"]);
    expect(audit.filter((e) => e.kind === "skill").map((e) => e.outcome)).toEqual(["denied", "denied"]);
  });

  it("redacts prompt results, never skill files, and leaves catalog names alone", async () => {
    const { g } = await gate({ redact: [{ pattern: /[\w.]+@[\w.]+/, replacement: "[EMAIL]" }, { pattern: "read_x", replacement: "X" }] });
    const p = (await g.client.getPrompt("greet", { who: "ann" }, "up")) as { messages: Array<{ content: { text: string } }> };
    expect(p.messages[0]!.content.text).toBe("hi ann [EMAIL]");
    const skill = await g.client.getSkill(ENTRY.uri, "up");
    const f = await g.client.readSkillFile(skill);
    // Owner decision (#82): a skill file's digest covers its bytes, so the gate never rewrites them.
    expect(f.text).toBe("mail a@b.com");
    expect(new TextDecoder().decode(f.bytes)).toBe("mail a@b.com");
    expect(f.verified).toBe(true);
    expect(g.client.listTools("up").map((t) => t.name)).toEqual(["read_x", "secret_op"]);
  });

  it("compilePolicy leaves list and skill operations allowed", () => {
    const p = compilePolicy({ allow: ["nothing.*"], deny: ["*"] });
    const base = { server: "up", destructive: false, readOnly: false };
    expect(p({ ...base, kind: "list", target: "tools" })).toBe("allow");
    expect(p({ ...base, kind: "skill", target: "skills" })).toBe("allow");
    expect(p({ ...base, kind: "prompt", target: "greet" })).toBe("deny");
  });
});
