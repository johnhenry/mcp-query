import { afterEach, describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { MCPClient, skillFileCacheKey, type Skill, type SkillsSdk } from "@johnhenry/mcp-query";
import { InteractionBroker } from "@johnhenry/mcp-query";
import { MockMCPServer } from "@johnhenry/mcp-query/testing";
import { mcpqSkillFileQueryOptions, mcpqSkillQueryOptions, mcpqSkillsQueryOptions } from "../src/queryOptions.js";
import { attachMcpqSync } from "../src/bridge.js";

// An injected SDK skills module, so these run on the lockfile's SDK (no ext/skills needed).
const ROOT = "skill://git-commit/";
const ENTRY = {
  uri: `${ROOT}SKILL.md`,
  frontmatter: { name: "git-commit", description: "Commits" },
  resources: [
    { uri: `${ROOT}SKILL.md`, digest: "sha256:aaa", size: 4 },
    { uri: `${ROOT}references/STYLE.md`, digest: "sha256:bbb", size: 4 },
  ],
};
const DYNAMIC = { uri: "skill://live/SKILL.md", frontmatter: { name: "live", description: "Live" }, resources: "dynamic" as const };

function fakeSdk(calls: string[]): () => Promise<SkillsSdk> {
  class SkillsClient {
    async list() {
      calls.push("list");
      return { skills: [ENTRY, DYNAMIC], ttlMs: 60_000, cacheScope: "public" as const };
    }
    async get(uri: string) {
      calls.push(`get ${uri}`);
      return { skill: uri === DYNAMIC.uri ? DYNAMIC : ENTRY, ttlMs: 60_000, cacheScope: "public" as const };
    }
    async read(skill: { uri: string; resources: unknown }, ref?: string) {
      calls.push(`read ${ref ?? skill.uri}`);
      return { uri: ref ?? skill.uri, bytes: new Uint8Array([1, 2]), text: "body", verified: skill.resources !== "dynamic" };
    }
  }
  return async () => ({ SkillsClient }) as unknown as SkillsSdk;
}

const opened: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
});

async function setup(cfg: Partial<ConstructorParameters<typeof MCPClient>[0]> = {}) {
  const calls: string[] = [];
  const mock = new MockMCPServer({ skills: [{ name: "git-commit", description: "Commits" }] }, { era: "legacy" });
  const client = new MCPClient({ servers: { s: { transport: mock.transport } }, skillsSdk: fakeSdk(calls), ...cfg });
  opened.push(mock, client);
  await client.connect();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return { client, qc, calls };
}

describe("mcpqSkillsQueryOptions", () => {
  it("queryFn delegates to client.listSkills; the key is under [ns, server, skills]", async () => {
    const { client, qc, calls } = await setup();
    const opts = mcpqSkillsQueryOptions(client, "s");
    expect(opts.queryKey).toEqual(["mcp-query", "s", "skills", "list"]);
    const skills = await qc.fetchQuery(opts);
    expect(skills.map((k) => [k.server, k.frontmatter.name])).toEqual([["s", "git-commit"], ["s", "live"]]);
    expect(calls).toEqual(["list"]);
  });

  it("a resources list_changed invalidates the bridged query (TanStack refetches it)", async () => {
    const { client, qc, calls } = await setup();
    const opts = mcpqSkillsQueryOptions(client, "s");
    await qc.fetchQuery(opts);
    const unsub = attachMcpqSync(client, qc);
    expect(qc.getQueryState(opts.queryKey)?.isInvalidated).toBe(false);
    client.cache.invalidateTags(["skills:s"], false); // what a resources list_changed does
    expect(qc.getQueryState(opts.queryKey)?.isInvalidated).toBe(true);
    // other servers' skills are left alone
    expect(qc.getQueryState(mcpqSkillsQueryOptions(client, "other").queryKey)).toBeUndefined();
    unsub();
  });

  it("the mcp-query cache is mirrored into TanStack without a refetch (force-refresh updates the query data)", async () => {
    const { client, qc, calls } = await setup();
    const opts = mcpqSkillsQueryOptions(client, "s");
    await qc.fetchQuery(opts);
    await client.listSkills("s", { force: true });
    expect(qc.getQueryData(opts.queryKey)).toHaveLength(2);
    expect(calls.filter((c) => c === "list")).toHaveLength(2);
  });

  it("a partition gets its own query key and its own mcp-query entry", async () => {
    const { client, qc, calls } = await setup();
    const a = mcpqSkillsQueryOptions(client, "s", { context: { partition: "a" } });
    const b = mcpqSkillsQueryOptions(client, "s", { context: { partition: "b" } });
    expect(a.queryKey).not.toEqual(b.queryKey);
    await qc.fetchQuery(a);
    await qc.fetchQuery(b);
    expect(calls.filter((c) => c === "list")).toHaveLength(2);
  });

  it("a server without the skills extension surfaces the client's error", async () => {
    const plain = new MockMCPServer({ tools: [{ name: "t" }] });
    const client = new MCPClient({ servers: { p: { transport: plain.transport } }, skillsSdk: fakeSdk([]) });
    opened.push(plain, client);
    await client.connect();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await expect(qc.fetchQuery(mcpqSkillsQueryOptions(client, "p"))).rejects.toThrow(/does not advertise the skills extension/);
  });
});

describe("mcpqSkillQueryOptions", () => {
  it("delegates to client.getSkill", async () => {
    const { client, qc, calls } = await setup();
    const opts = mcpqSkillQueryOptions(client, ENTRY.uri, "s");
    expect(opts.queryKey).toEqual(["mcp-query", "s", "skills", "get", ENTRY.uri]);
    const skill = await qc.fetchQuery(opts);
    expect(skill).toMatchObject({ server: "s", uri: ENTRY.uri });
    expect(calls).toEqual([`get ${ENTRY.uri}`]);
  });
});

describe("mcpqSkillFileQueryOptions", () => {
  it("keys by manifest digest, delegates to readSkillFile, and the cache key matches mcp-query's own", async () => {
    const { client, qc, calls } = await setup();
    const skill = await client.getSkill(ENTRY.uri, "s");
    const md = mcpqSkillFileQueryOptions(client, skill);
    expect(md.queryKey).toEqual(["mcp-query", "s", "skills", "file", ENTRY.uri, "sha256:aaa"]);
    const style = mcpqSkillFileQueryOptions(client, skill, "./references/STYLE.md");
    expect(style.queryKey).toEqual(["mcp-query", "s", "skills", "file", `${ROOT}references/STYLE.md`, "sha256:bbb"]);
    expect(skillFileCacheKey(skill, "references/STYLE.md")).toMatchObject({ uri: `${ROOT}references/STYLE.md`, digest: "sha256:bbb" });
    const file = await qc.fetchQuery(style);
    expect(file).toMatchObject({ server: "s", verified: true, text: "body" });
    expect(calls).toContain("read ./references/STYLE.md");
  });

  it("dynamic skills: key says dynamic, never fresh in TanStack", async () => {
    const { client, qc } = await setup();
    const skill = await client.getSkill(DYNAMIC.uri, "s");
    const opts = mcpqSkillFileQueryOptions(client, skill);
    expect(opts.queryKey).toEqual(["mcp-query", "s", "skills", "file", DYNAMIC.uri, "dynamic"]);
    expect(opts.staleTime).toBe(0);
    expect((await qc.fetchQuery(opts)).verified).toBe(false);
  });

  it("a denied approval is the query's error and nothing is cached", async () => {
    const broker = new InteractionBroker({ policy: () => "deny" });
    const { client, qc } = await setup({ interactions: broker, skillApproval: true });
    const skill: Skill = { ...ENTRY, server: "s" };
    await expect(qc.fetchQuery(mcpqSkillFileQueryOptions(client, skill))).rejects.toThrow(/was not approved/);
    expect(client.cache.getSnapshot(skillFileCacheKey(skill)!)?.status).not.toBe("success");
  });
});
