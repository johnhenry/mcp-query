// Skills over MCP (io.modelcontextprotocol/skills, SEP-2640): list / get / read with
// SDK-side verification, caching, invalidation, error mapping. Runs against
// MockMCPServer's skills fixture and — in a second block — against a real SDK 2.4.0
// server (`loadSkills(folder)` + `SkillsExtension.attach`).
//
// The skills client lives at `@modelcontextprotocol/client/ext/skills` (SDK >= 2.4.0).
// On an older SDK (the sdk-matrix floor leg, 2.0.0) the SDK-backed blocks are SKIPPED, visibly,
// with the reason in their name; the capability / missing-SDK tests always run.

import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MCPClient } from "../src/core/client.js";
import { MCPError } from "../src/core/types.js";
import { skillVerificationReason, skillsSdkAvailable, SKILLS_MIN_SDK } from "../src/core/skills.js";
import { MockMCPServer, type MockSkill } from "../src/testing/mockServer.js";

const hasSdk = await skillsSdkAvailable();
const SKIP_WHY = `Skills over MCP needs @modelcontextprotocol/client >= ${SKILLS_MIN_SDK} (installed SDK lacks ext/skills)`;

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

async function setup(skills: MockSkill[], opts: { era?: "legacy" | "modern" | "both"; versions?: string[]; cache?: { ttlMs: number; cacheScope?: "public" | "private" } } = {}) {
  const server = new MockMCPServer({ skills, skillsCache: opts.cache }, { era: opts.era ?? "legacy" });
  const client = new MCPClient({
    servers: { s: { transport: server.transport } },
    ...(opts.versions ? { versions: opts.versions } : {}),
  });
  opened.push(server, client);
  await client.connect();
  return { server, client };
}

describe("skills capability (no SDK subpath needed)", () => {
  it("supports('skills') follows the advertised extension", async () => {
    const withSkills = new MockMCPServer({ skills: [GOOD] }, { era: "legacy" });
    const without = new MockMCPServer({ resources: [{ uri: "x://a" }] }, { era: "legacy" });
    const client = new MCPClient({ servers: { a: { transport: withSkills.transport }, b: { transport: without.transport } } });
    opened.push(withSkills, without, client);
    await client.connect();
    expect(client.connection("a")!.supports("skills")).toBe(true);
    expect(client.connection("b")!.supports("skills")).toBe(false);
  });

  it("a server that does not advertise skills is a clear error when named, skipped in the union", async () => {
    const without = new MockMCPServer({ resources: [{ uri: "x://a" }] }, { era: "legacy" });
    const client = new MCPClient({ servers: { b: { transport: without.transport } }, skillsSdk: async () => ({}) as never });
    opened.push(without, client);
    await client.connect();
    await expect(client.listSkills("b")).rejects.toThrow(/does not advertise the skills extension/);
    await expect(client.listSkills()).resolves.toEqual([]);
  });

  it("an SDK without ext/skills fails with an MCPError naming the minimum version", async () => {
    const server = new MockMCPServer({ skills: [GOOD] }, { era: "legacy" });
    const client = new MCPClient({
      servers: { s: { transport: server.transport } },
      skillsSdk: () => Promise.reject(new Error("Package subpath './ext/skills' is not defined by exports")),
    });
    opened.push(server, client);
    await client.connect();
    const err = await client.listSkills("s").catch((e) => e);
    expect(err).toBeInstanceOf(MCPError);
    expect(err.message).toContain(`>= ${SKILLS_MIN_SDK}`);
    expect(err.message).toContain("@modelcontextprotocol/client");
  });

  it.skipIf(hasSdk)("on the installed (old) SDK the default loader gives that same clear error", async () => {
    const { client } = await setup([GOOD]);
    await expect(client.listSkills("s")).rejects.toThrow(`>= ${SKILLS_MIN_SDK}`);
  });
});

describe.skipIf(!hasSdk)(`skills against MockMCPServer${hasSdk ? "" : ` — SKIPPED: ${SKIP_WHY}`}`, () => {
  for (const [label, era, versions] of [
    ["legacy era", "legacy", undefined],
    ["modern era", "modern", ["2026-07-28"]],
  ] as const) {
    describe(label, () => {
      const cfg = { era, versions: versions ? [...versions] : undefined, cache: { ttlMs: 60_000, cacheScope: "public" as const } };

      it("lists skills tagged with their server", async () => {
        const { client } = await setup([GOOD, { name: "pdf", description: "Work with PDFs" }], cfg);
        const skills = await client.listSkills("s");
        expect(skills.map((s) => s.uri).sort()).toEqual(["skill://git-commit/SKILL.md", "skill://pdf/SKILL.md"]);
        expect(skills.every((s) => s.server === "s")).toBe(true);
        const first = skills.find((s) => s.uri.includes("git-commit"))!;
        expect(first.frontmatter).toMatchObject({ name: "git-commit", description: "Write good commit messages" });
        expect(Array.isArray(first.resources) && first.resources.map((r) => r.uri)).toContain("skill://git-commit/references/STYLE.md");
      });

      it("caches the listing (ttl honoured) until forced or invalidated", async () => {
        const { client, server } = await setup([GOOD], cfg);
        await client.listSkills("s");
        await client.listSkills("s");
        expect(server.skillLog.filter((l) => l === "skills/list")).toHaveLength(1);
        await client.listSkills("s", { force: true });
        expect(server.skillLog.filter((l) => l === "skills/list")).toHaveLength(2);
      });

      it("a resources list_changed makes the catalog stale; the next list re-fetches the new set", async () => {
        const { client, server } = await setup([GOOD], cfg);
        expect(await client.listSkills("s")).toHaveLength(1);
        server.spec.skills = [GOOD, { name: "pdf", description: "Work with PDFs" }];
        await server.notifyResourceListChanged();
        await expect.poll(() => client.cache.isStale({ kind: "skillList", server: "s" }), { timeout: 5000 }).toBe(true);
        expect(await client.listSkills("s")).toHaveLength(2);
      });

      it("getSkill fetches one entry by URI and caches it", async () => {
        const { client, server } = await setup([GOOD], cfg);
        const skill = await client.getSkill("skill://git-commit/SKILL.md", "s");
        expect(skill.server).toBe("s");
        expect(skill.frontmatter.name).toBe("git-commit");
        await client.getSkill("skill://git-commit/SKILL.md", "s");
        expect(server.skillLog.filter((l) => l.startsWith("skills/get"))).toHaveLength(1);
        await expect(client.getSkill("skill://nope/SKILL.md", "s")).rejects.toBeInstanceOf(MCPError);
      });

      it("reads SKILL.md and a reference file, verified, and serves repeats from the digest-keyed cache", async () => {
        const { client, server } = await setup([GOOD], cfg);
        const [skill] = await client.listSkills("s");
        const md = await client.readSkillFile(skill!);
        expect(md.verified).toBe(true);
        expect(md.server).toBe("s");
        expect(md.text).toContain("Use the imperative mood.");
        expect(md.frontmatter).toMatchObject({ name: "git-commit" });
        expect(md.body).toContain("imperative");

        const ref = await client.readSkillFile(skill!, "references/STYLE.md");
        expect(ref.text).toBe("# Style\nKeep it short.\n");
        expect(ref.verified).toBe(true);

        const reads = () => server.skillLog.filter((l) => l.startsWith("read ")).length;
        const before = reads();
        await client.readSkillFile(skill!);
        await client.readSkillFile(skill!, "references/STYLE.md");
        expect(reads()).toBe(before); // both served from cache
      });

      it("a changed manifest (new digest) never serves the old bytes", async () => {
        const { client, server } = await setup([GOOD], cfg);
        const [v1] = await client.listSkills("s");
        expect((await client.readSkillFile(v1!)).text).toContain("imperative");
        server.spec.skills = [{ ...GOOD, body: "Use the past tense." }];
        const [v2] = await client.listSkills("s", { force: true });
        expect((await client.readSkillFile(v2!)).text).toContain("past tense");
      });

      it("rejects a tampered digest with the SDK reason preserved, and never caches it", async () => {
        const { client, server } = await setup([{ ...GOOD, tamper: "digest" }], cfg);
        const [skill] = await client.listSkills("s");
        const err = await client.readSkillFile(skill!).catch((e) => e);
        expect(err).toBeInstanceOf(MCPError);
        expect(skillVerificationReason(err)).toBe("digest");
        expect(err.server).toBe("s");
        expect(err.uri).toBe("skill://git-commit/SKILL.md");
        const reads = server.skillLog.filter((l) => l.startsWith("read ")).length;
        await expect(client.readSkillFile(skill!)).rejects.toBeInstanceOf(MCPError); // re-verified, not cached
        expect(server.skillLog.filter((l) => l.startsWith("read ")).length).toBeGreaterThan(reads);
      });

      it("rejects a wrong size", async () => {
        const { client } = await setup([{ ...GOOD, tamper: "size" }], cfg);
        const [skill] = await client.listSkills("s");
        const err = await client.readSkillFile(skill!, "references/STYLE.md").catch((e) => e);
        expect(skillVerificationReason(err)).toBe("size");
      });

      it("rejects SKILL.md whose frontmatter differs from the listed entry", async () => {
        const { client } = await setup([{ ...GOOD, tamper: "frontmatter" }], cfg);
        const [skill] = await client.listSkills("s");
        const err = await client.readSkillFile(skill!).catch((e) => e);
        expect(skillVerificationReason(err)).toBe("frontmatter");
        expect(err.data.skillVerification.differences.join("\n")).toMatch(/description/);
      });

      it("rejects a file the manifest does not list (unlisted) before any request", async () => {
        const { client, server } = await setup([GOOD], cfg);
        const [skill] = await client.listSkills("s");
        const before = server.skillLog.length;
        const err = await client.readSkillFile(skill!, "references/SECRET.md").catch((e) => e);
        expect(skillVerificationReason(err)).toBe("unlisted");
        expect(server.skillLog.length).toBe(before);
      });

      it('"dynamic" skills read back unverified and are never cached', async () => {
        const { client, server } = await setup([{ name: "live", description: "Generated on demand", dynamic: true }], cfg);
        const [skill] = await client.listSkills("s");
        expect(skill!.resources).toBe("dynamic");
        const a = await client.readSkillFile(skill!);
        expect(a.verified).toBe(false);
        await client.readSkillFile(skill!);
        expect(server.skillLog.filter((l) => l.startsWith("read ")).length).toBe(2);
      });

      it("keeps cache entries per client.scope() partition", async () => {
        const { client, server } = await setup([GOOD], cfg);
        await client.scope({ partition: "tenant-a" }).listSkills("s");
        await client.scope({ partition: "tenant-b" }).listSkills("s");
        await client.scope({ partition: "tenant-a" }).listSkills("s");
        expect(server.skillLog.filter((l) => l === "skills/list")).toHaveLength(2);
        expect(client.cache.getSnapshot({ kind: "skillList", server: "s", partition: "tenant-a" })?.status).toBe("success");
      });
    });
  }

  it("with no server argument, unions every skills-capable server and tags each skill", async () => {
    const a = new MockMCPServer({ skills: [GOOD] }, { era: "legacy" });
    const b = new MockMCPServer({ skills: [{ name: "pdf", description: "PDFs" }] }, { era: "legacy" });
    const c = new MockMCPServer({ resources: [{ uri: "x://a" }] }, { era: "legacy" });
    const client = new MCPClient({ servers: { a: { transport: a.transport }, b: { transport: b.transport }, c: { transport: c.transport } } });
    opened.push(a, b, c, client);
    await client.connect();
    const all = await client.listSkills();
    expect(all.map((s) => `${s.server}:${s.frontmatter.name}`).sort()).toEqual(["a:git-commit", "b:pdf"]);
  });

  it("union: a failing server is skipped and reported through onError", async () => {
    const good = new MockMCPServer({ skills: [GOOD] }, { era: "legacy" });
    const bad = new MockMCPServer({ skills: [GOOD] }, { era: "legacy" });
    const client = new MCPClient({ servers: { good: { transport: good.transport }, bad: { transport: bad.transport } } });
    opened.push(good, bad, client);
    await client.connect();
    bad.spec.skills = [{ name: "BAD NAME", description: "x" }]; // an entry the SDK refuses at list time
    const errors: string[] = [];
    const all = await client.listSkills(undefined, { onError: (s) => errors.push(s) });
    expect(all.every((s) => s.server === "good")).toBe(true);
    expect(errors).toEqual(["bad"]);
  });
});

// ── a real SDK 2.4.0 server: loadSkills(folder) + SkillsExtension.attach(server) ──
let sdkServer: { createMcpHandler: typeof import("@modelcontextprotocol/server").createMcpHandler; McpServer: typeof import("@modelcontextprotocol/server").McpServer } | undefined;
let skillsServer: { loadSkills: (root: string) => Promise<{ attach(mcp: unknown): void }> } | undefined;
try {
  const spec = "@modelcontextprotocol/server/ext/skills/node"; // subpath only exists on SDK >= 2.4.0
  skillsServer = await import(/* @vite-ignore */ spec);
  sdkServer = (await import("@modelcontextprotocol/server")) as never;
} catch {
  /* old SDK: block below is skipped */
}
const hasServerSkills = hasSdk && !!skillsServer && !!sdkServer;

describe.skipIf(!hasServerSkills)(`skills against an SDK server (loadSkills + SkillsExtension.attach)${hasServerSkills ? "" : ` — SKIPPED: ${SKIP_WHY}`}`, () => {
  it("lists, gets and reads a folder of skills, verified end to end (legacy and modern eras)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcpq-skills-"));
    try {
      await mkdir(join(dir, "release-notes", "references"), { recursive: true });
      await writeFile(join(dir, "release-notes", "SKILL.md"), "---\nname: release-notes\ndescription: Draft release notes from merged PRs\n---\nGroup by area.\n");
      await writeFile(join(dir, "release-notes", "references", "TONE.md"), "Friendly, factual.\n");
      const catalog = await skillsServer!.loadSkills(dir);

      const { createMcpHandler, McpServer } = sdkServer!;
      const handler = createMcpHandler(() => {
        const mcp = new McpServer({ name: "skills-sdk", version: "1.0.0" });
        catalog.attach(mcp);
        return mcp;
      });
      const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client");
      const transport = () => new StreamableHTTPClientTransport(new URL("http://sdk.local/mcp"), { fetch: (u, i) => handler.fetch(new Request(u, i)) });

      for (const versions of [undefined, ["2026-07-28"]]) {
        const client = new MCPClient({ servers: { sdk: { transport } }, ...(versions ? { versions } : {}) });
        opened.push(client);
        await client.connect();
        expect(client.connection("sdk")!.supports("skills")).toBe(true);
        const [skill] = await client.listSkills("sdk");
        expect(skill!.uri).toBe("skill://release-notes/SKILL.md");
        expect(skill!.server).toBe("sdk");
        expect((await client.getSkill(skill!.uri, "sdk")).frontmatter.name).toBe("release-notes");
        const md = await client.readSkillFile(skill!);
        expect(md.verified).toBe(true);
        expect(md.body).toContain("Group by area.");
        expect((await client.readSkillFile(skill!, "references/TONE.md")).text).toBe("Friendly, factual.\n");
        await client.close();
      }
      await handler.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
