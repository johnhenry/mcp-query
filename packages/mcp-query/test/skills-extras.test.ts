// Skills over MCP, second wave, against the REAL SDK `SkillsClient` (SDK >= 2.4.0):
// directory reads, `_meta` forwarding through the SDK's own request path (both
// protocol eras), L2-stored files, and the approval gate. Skipped, visibly, on an
// older SDK; skills-extras-fake-sdk.test.ts covers the same logic on every SDK.

import { afterEach, describe, expect, it } from "vitest";
import { MCPClient } from "../src/core/client.js";
import { MemoryCacheStore } from "../src/core/cacheStore.js";
import { InteractionBroker } from "../src/core/interactions.js";
import { MCPError } from "../src/core/types.js";
import { skillVerificationReason, skillsSdkAvailable, SKILLS_MIN_SDK } from "../src/core/skills.js";
import { MockMCPServer, type MockSkill } from "../src/testing/mockServer.js";

const hasSdk = await skillsSdkAvailable();
const SKIP_WHY = `needs @modelcontextprotocol/client >= ${SKILLS_MIN_SDK} (installed SDK lacks ext/skills)`;

const opened: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
});

const GOOD: MockSkill = {
  name: "git-commit",
  description: "Write good commit messages",
  body: "Use the imperative mood.",
  files: { "references/STYLE.md": "# Style\nKeep it short.\n" },
};

async function setup(
  skills: MockSkill[],
  era: "legacy" | "modern",
  cfg: Partial<ConstructorParameters<typeof MCPClient>[0]> = {},
  directory = true,
) {
  const server = new MockMCPServer({ skills, skillsDirectoryRead: directory, skillsCache: { ttlMs: 60_000, cacheScope: "public" } }, { era });
  const client = new MCPClient({
    servers: { s: { transport: server.transport } },
    ...(era === "modern" ? { versions: ["2026-07-28", "2025-11-25"] } : {}),
    ...cfg,
  });
  opened.push(server, client);
  await client.connect();
  return { server, client };
}

describe.skipIf(!hasSdk)(`skills second wave against the real SDK SkillsClient${hasSdk ? "" : ` — SKIPPED: ${SKIP_WHY}`}`, () => {
  for (const era of ["legacy", "modern"] as const) {
    describe(`${era} era`, () => {
      it("readSkillDirectory lists the direct children, with sub-directories marked", async () => {
        const { client, server } = await setup([GOOD], era);
        const root = await client.readSkillDirectory("skill://git-commit/", "s");
        expect(root.server).toBe("s");
        expect(root.resources.map((r) => [r.name, r.mimeType]).sort()).toEqual([
          ["SKILL.md", "text/markdown"],
          ["references", "inode/directory"],
        ]);
        const refs = await client.readSkillDirectory("skill://git-commit/references/", "s");
        expect(refs.resources.map((r) => r.name)).toEqual(["STYLE.md"]);
        await client.readSkillDirectory("skill://git-commit/", "s");
        expect(server.skillLog.filter((l) => l.startsWith("dir "))).toHaveLength(2); // second root read cached
      });

      it("a server without directoryRead is a clear MCPError, before any request", async () => {
        const { client, server } = await setup([GOOD], era, {}, false);
        await expect(client.readSkillDirectory("skill://git-commit/", "s")).rejects.toThrow(/does not advertise directoryRead/);
        expect(server.skillLog.some((l) => l.startsWith("dir "))).toBe(false);
      });

      it("CallContext.meta rides on list, get, read and directory requests through the SDK", async () => {
        const { client, server } = await setup([GOOD], era);
        const meta = { tenant: "acme", principal: "u1" };
        const scoped = client.scope({ meta });
        const [skill] = await scoped.listSkills("s");
        await scoped.getSkill(skill!.uri, "s");
        const file = await scoped.readSkillFile(skill!);
        await scoped.readSkillDirectory("skill://git-commit/", "s");
        expect(file.verified).toBe(true); // verification still works over the proxied client
        const by = Object.fromEntries(server.skillMetaLog.map((l) => [l.method, l.meta]));
        for (const m of ["skills/list", "skills/get", "resources/read", "resources/directory/read"]) expect(by[m], m).toMatchObject(meta);
      });

      it("verification failures keep their reason on the meta-carrying path too", async () => {
        const { client } = await setup([{ ...GOOD, name: "bad", tamper: "digest" }], era);
        const scoped = client.scope({ meta: { principal: "u1" } });
        const [skill] = await scoped.listSkills("s");
        const err = await scoped.readSkillFile(skill!).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(MCPError);
        expect(skillVerificationReason(err)).toBe("digest");
      });

      it("verified files go through the shared store and come back identical", async () => {
        const store = new MemoryCacheStore();
        const a = await setup([GOOD], era, { cacheStore: store });
        const [skillA] = await a.client.listSkills("s");
        const fileA = await a.client.readSkillFile(skillA!);
        await new Promise((r) => setTimeout(r, 20));
        const b = await setup([GOOD], era, { cacheStore: store });
        const [skillB] = await b.client.listSkills("s");
        const fileB = await b.client.readSkillFile(skillB!);
        expect(b.server.skillLog.filter((l) => l.startsWith("read "))).toHaveLength(0); // served from L2
        expect(fileB).toMatchObject({ verified: true, text: fileA.text, body: fileA.body, frontmatter: fileA.frontmatter });
        expect([...fileB.bytes]).toEqual([...fileA.bytes]);
      });

      it("approval gates the real read; a denial reads nothing", async () => {
        const broker = new InteractionBroker({ policy: () => "deny" });
        const { client, server } = await setup([GOOD], era, { interactions: broker, skillApproval: true });
        const [skill] = await client.listSkills("s");
        await expect(client.readSkillFile(skill!)).rejects.toThrow(/was not approved/);
        expect(server.skillLog.some((l) => l.startsWith("read "))).toBe(false);
      });
    });
  }
});
