// Skills over MCP against an INJECTED fake SDK skills module (`skillsSdk`), so the
// controller, cache, error mapping and scope() paths run on every supported SDK,
// including ones older than 2.4.0 that have no `ext/skills` subpath. The SDK-backed
// behaviour (real verification) is covered by skills.test.ts on SDK >= 2.4.0.

import { afterEach, describe, expect, it } from "vitest";
import { MCPClient } from "../src/core/client.js";
import { MCPError } from "../src/core/types.js";
import { loadSkillsSdk, skillVerificationReason, skillsSdkAvailable, type SkillsSdk } from "../src/core/skills.js";
import { MockMCPServer } from "../src/testing/mockServer.js";

const opened: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
});

const ROOT = "skill://git-commit/";
const ENTRY = {
  uri: `${ROOT}SKILL.md`,
  frontmatter: { name: "git-commit", description: "Commits" },
  resources: [
    { uri: `${ROOT}SKILL.md`, digest: "sha256:aaa", size: 10 },
    { uri: `${ROOT}references/STYLE.md`, digest: "sha256:bbb", size: 5 },
  ],
};
const DYNAMIC = { uri: "skill://live/SKILL.md", frontmatter: { name: "live", description: "Live" }, resources: "dynamic" as const };

class FakeVerificationError extends Error {
  override name = "SkillVerificationError";
  constructor(readonly reason: string, readonly uri: string, readonly differences: readonly string[] = []) {
    super(`skill verification failed: ${reason}`);
  }
}

interface FakeState {
  calls: string[];
  instances: number;
  /** Instances (1-based construction order) whose list() rejects. */
  failList?: number[];
  readError?: Error;
  ttlMs?: number;
}

function fakeSdk(state: FakeState): () => Promise<SkillsSdk> {
  class SkillsClient {
    readonly n: number;
    constructor(_raw: unknown) {
      this.n = ++state.instances;
    }
    async list() {
      state.calls.push(`list#${this.n}`);
      if (state.failList?.includes(this.n)) throw new Error("upstream exploded");
      return { skills: [ENTRY, DYNAMIC], ttlMs: state.ttlMs ?? 60_000, cacheScope: "private" as const };
    }
    async get(uri: string) {
      state.calls.push(`get ${uri}`);
      return { skill: uri === DYNAMIC.uri ? DYNAMIC : ENTRY, ttlMs: state.ttlMs ?? 60_000, cacheScope: "private" as const };
    }
    async read(skill: { uri: string; resources: unknown }, ref?: string) {
      state.calls.push(`read ${ref ?? skill.uri}`);
      if (state.readError) throw state.readError;
      const dynamic = skill.resources === "dynamic";
      return { uri: ref ?? skill.uri, bytes: new Uint8Array([1, 2, 3]), text: "body", verified: !dynamic };
    }
  }
  return async () => ({ SkillsClient }) as unknown as SkillsSdk;
}

async function setup(state: FakeState, servers = 1) {
  const conf: Record<string, { transport: unknown }> = {};
  for (let i = 0; i < servers; i++) {
    const server = new MockMCPServer({ skills: [{ name: "git-commit", description: "Commits" }] }, { era: "legacy" });
    opened.push(server);
    conf[`s${i}`] = { transport: server.transport };
  }
  const client = new MCPClient({ servers: conf as never, skillsSdk: fakeSdk(state) });
  opened.push(client);
  await client.connect();
  return client;
}

const fresh = (): FakeState => ({ calls: [], instances: 0 });

describe("skills controller with an injected SDK module", () => {
  it("listSkills(server) tags entries with the server, caches, and refetches on force", async () => {
    const state = fresh();
    const client = await setup(state);
    const first = await client.listSkills("s0");
    expect(first.map((s) => [s.server, s.frontmatter.name])).toEqual([["s0", "git-commit"], ["s0", "live"]]);
    await client.listSkills("s0");
    expect(state.calls.filter((c) => c.startsWith("list"))).toHaveLength(1);
    await client.listSkills("s0", { force: true });
    expect(state.calls.filter((c) => c.startsWith("list"))).toHaveLength(2);
    expect(state.instances).toBe(1); // one SDK SkillsClient per live connection
  });

  it("the server ttl is honoured: once it elapses a later list refetches", async () => {
    const state = { ...fresh(), ttlMs: 5 };
    const client = await setup(state);
    await client.listSkills("s0");
    await new Promise((r) => setTimeout(r, 40));
    await client.listSkills("s0");
    expect(state.calls.filter((c) => c.startsWith("list"))).toHaveLength(2);
  });

  it("listSkills() unions servers, skipping a failing one and reporting it through onError", async () => {
    const state = { ...fresh(), failList: [2] };
    const client = await setup(state, 2);
    const errors: Array<[string, MCPError]> = [];
    const all = await client.listSkills(undefined, { onError: (server, error) => errors.push([server, error]) });
    expect(new Set(all.map((s) => s.server)).size).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]![1]).toBeInstanceOf(MCPError);
    // Named, the same failure rejects.
    await expect(client.listSkills(errors[0]![0], { force: true })).rejects.toBeInstanceOf(MCPError);
  });

  it("getSkill caches by uri", async () => {
    const state = fresh();
    const client = await setup(state);
    const a = await client.getSkill(ENTRY.uri, "s0");
    const b = await client.getSkill(ENTRY.uri, "s0");
    expect(a.server).toBe("s0");
    expect(b.frontmatter.name).toBe("git-commit");
    expect(state.calls.filter((c) => c.startsWith("get"))).toHaveLength(1);
  });

  it("readSkillFile caches verified bytes by digest, for SKILL.md and a relative ref", async () => {
    const state = fresh();
    const client = await setup(state);
    const skill = await client.getSkill(ENTRY.uri, "s0");
    const md = await client.readSkillFile(skill);
    expect(md).toMatchObject({ server: "s0", verified: true, text: "body" });
    await client.readSkillFile(skill);
    await client.readSkillFile(skill, "references/STYLE.md");
    await client.readSkillFile(skill, "./references/STYLE.md");
    expect(state.calls.filter((c) => c.startsWith("read"))).toHaveLength(2);
    await client.readSkillFile(skill, undefined, { force: true });
    expect(state.calls.filter((c) => c.startsWith("read"))).toHaveLength(3);
  });

  it("dynamic skills come back unverified and are never cached", async () => {
    const state = fresh();
    const client = await setup(state);
    const skill = await client.getSkill(DYNAMIC.uri, "s0");
    const one = await client.readSkillFile(skill);
    await client.readSkillFile(skill);
    expect(one.verified).toBe(false);
    expect(state.calls.filter((c) => c.startsWith("read"))).toHaveLength(2);
  });

  it("an SDK verification failure keeps its reason on the MCPError", async () => {
    const state = { ...fresh(), readError: new FakeVerificationError("digest", ENTRY.uri, ["sha256 differs"]) };
    const client = await setup(state);
    const skill = await client.getSkill(ENTRY.uri, "s0");
    const err = await client.readSkillFile(skill).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MCPError);
    expect(skillVerificationReason(err)).toBe("digest");
    expect((err as MCPError).data).toMatchObject({ skillVerification: { uri: ENTRY.uri, differences: ["sha256 differs"] } });
    expect(skillVerificationReason(new Error("x"))).toBeUndefined();
  });

  it("other read failures go through the client's error mapping", async () => {
    const state = { ...fresh(), readError: new Error("socket closed") };
    const client = await setup(state);
    const skill = await client.getSkill(ENTRY.uri, "s0");
    await expect(client.readSkillFile(skill)).rejects.toBeInstanceOf(MCPError);
  });

  it("rejects a skill with no server, and an unknown server", async () => {
    const client = await setup(fresh());
    await expect(client.readSkillFile({ ...ENTRY } as never)).rejects.toThrow(/has no `server`/);
    await expect(client.listSkills("nope")).rejects.toThrow(/unknown server/);
  });

  it("scope() exposes the same three calls, partitioned", async () => {
    const state = fresh();
    const client = await setup(state);
    const scoped = client.scope({ partition: "tenant-a" });
    const listed = await scoped.listSkills("s0");
    const skill = await scoped.getSkill(ENTRY.uri, "s0");
    const file = await scoped.readSkillFile(skill);
    expect(listed).toHaveLength(2);
    expect(file.verified).toBe(true);
    // A different partition does not share the cached listing.
    await client.listSkills("s0");
    expect(state.calls.filter((c) => c.startsWith("list"))).toHaveLength(2);
  });

  it("a custom loader that rejects gets the clear minimum-version error", async () => {
    const server = new MockMCPServer({ skills: [{ name: "git-commit", description: "Commits" }] }, { era: "legacy" });
    const client = new MCPClient({ servers: { s: { transport: server.transport } }, skillsSdk: () => Promise.reject(new Error("no subpath")) });
    opened.push(server, client);
    await client.connect();
    await expect(client.listSkills("s")).rejects.toThrow(/needs @modelcontextprotocol\/client >=/);
  });
});

describe("skills SDK loader", () => {
  it("skillsSdkAvailable reflects whether a loader resolves", async () => {
    expect(await skillsSdkAvailable(async () => ({}) as SkillsSdk)).toBe(true);
    expect(await skillsSdkAvailable(() => Promise.reject(new Error("missing")))).toBe(false);
  });

  it("the default loader resolves on SDK >= 2.4.0 and otherwise fails with the minimum-version MCPError", async () => {
    const available = await skillsSdkAvailable();
    if (available) await expect(loadSkillsSdk()).resolves.toHaveProperty("SkillsClient");
    else await expect(loadSkillsSdk()).rejects.toThrow(/needs @modelcontextprotocol\/client >=/);
  });
});
