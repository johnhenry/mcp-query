// #90: lists, prompts/get and the skills calls run through the interceptor chain.
import { afterEach, describe, expect, it, vi } from "vitest";
import { MCPClient } from "../src/core/client.js";
import type { Operation, RequestInterceptor } from "../src/core/interceptors.js";
import { MockMCPServer } from "../src/testing/mockServer.js";
import { authorize, AuthorizationError, listFilter, rateLimit, circuitBreaker } from "../src/server/index.js";
import type { SkillsSdk } from "../src/core/skills.js";

const opened: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
});

const ENTRY = {
  uri: "skill://git-commit/SKILL.md",
  frontmatter: { name: "git-commit", description: "Commits" },
  resources: [{ uri: "skill://git-commit/SKILL.md", digest: "sha256:aaa", size: 10 }],
};
const fakeSkills = (): (() => Promise<SkillsSdk>) => {
  class SkillsClient {
    async list() {
      return { skills: [ENTRY], ttlMs: 0, cacheScope: "private" as const };
    }
    async get() {
      return { skill: ENTRY, ttlMs: 0, cacheScope: "private" as const };
    }
    async read(skill: { uri: string }, ref?: string) {
      return { uri: ref ?? skill.uri, bytes: new Uint8Array([1]), text: "body", verified: true };
    }
  }
  return async () => ({ SkillsClient }) as unknown as SkillsSdk;
};

const mkMock = () =>
  new MockMCPServer(
    {
      tools: [
        { name: "echo", handler: () => ({ content: [{ type: "text", text: "hi" }] }) },
        { name: "secret", handler: () => ({ content: [{ type: "text", text: "s" }] }) },
      ],
      resources: [{ uri: "mem://a", read: () => ({ text: "A" }) }, { uri: "mem://hidden", read: () => ({ text: "H" }) }],
      templates: [{ uriTemplate: "mem://t/{id}", name: "t" }],
      prompts: [
        { name: "greet", get: (a) => ({ messages: [{ role: "user", content: { type: "text", text: `hello ${a.who}` } }] }) },
        { name: "internal", get: () => ({ messages: [] }) },
      ],
      skills: [{ name: "git-commit", description: "Commits" }],
    },
    { era: "legacy" },
  );

async function make(interceptors: RequestInterceptor[], onCall?: (e: { kind: string; target: string; outcome: string }) => void) {
  const mock = mkMock();
  const client = new MCPClient({ servers: { s: { transport: mock.transport } }, interceptors, onCall: onCall as never, skillsSdk: fakeSkills() });
  opened.push(mock, client);
  await client.connect();
  return { client, mock };
}

const recorder = () => {
  const seen: Array<Pick<Operation, "kind" | "peer" | "target" | "method">> = [];
  const interceptor: RequestInterceptor = (op, next) => {
    seen.push({ kind: op.kind, peer: op.peer, target: op.target, method: op.method });
    return next(op);
  };
  return { seen, interceptor };
};

describe("operations that run through the chain (#90)", () => {
  it("an interceptor observes the catalogs, prompts/get and each skills call", async () => {
    const { seen, interceptor } = recorder();
    const { client } = await make([interceptor]);
    // the four catalogs, vetted where they are fetched (connect)
    expect(seen.filter((o) => o.kind === "list").map((o) => o.target).sort()).toEqual(["prompts", "resourceTemplates", "resources", "tools"]);
    expect(seen.find((o) => o.target === "tools")).toMatchObject({ peer: "s", method: "tools/list" });
    seen.length = 0;
    await client.getPrompt("greet", { who: "ann" }, "s");
    await client.listSkills("s");
    const skill = await client.getSkill(ENTRY.uri, "s");
    await client.readSkillFile(skill);
    await client.readSkillFile(skill, "SKILL.md");
    expect(seen).toEqual([
      { kind: "prompt", peer: "s", target: "greet", method: "prompts/get" },
      { kind: "skill", peer: "s", target: "skills", method: "skills/list" },
      { kind: "skill", peer: "s", target: ENTRY.uri, method: "skills/get" },
      { kind: "skill", peer: "s", target: ENTRY.uri, method: "skills/read" },
      { kind: "skill", peer: "s", target: "SKILL.md", method: "skills/read" },
    ]);
  });

  it("listSkills() with no server runs one skill operation per skills-capable server", async () => {
    const { seen, interceptor } = recorder();
    const { client } = await make([interceptor]);
    seen.length = 0;
    expect((await client.listSkills()).map((s) => s.server)).toEqual(["s"]);
    expect(seen).toEqual([{ kind: "skill", peer: "s", target: "skills", method: "skills/list" }]);
  });

  it("a prompt interceptor can rewrite the arguments", async () => {
    const rewrite: RequestInterceptor = (op, next) => {
      if (op.kind === "prompt") op.args = { ...op.args, who: "bob" };
      return next(op);
    };
    const { client } = await make([rewrite]);
    const r = (await client.getPrompt("greet", { who: "ann" }, "s")) as { messages: Array<{ content: { text: string } }> };
    expect(r.messages[0]!.content.text).toBe("hello bob");
  });

  it("with no interceptors the accessors return the raw catalog and nothing is wrapped", async () => {
    const { client } = await make([]);
    expect(client.listTools("s").map((t) => t.name)).toEqual(["echo", "secret"]);
    expect(client.listResourceTemplates("s")).toHaveLength(1);
    expect(await client.getPrompt("greet", { who: "x" }, "s")).toBeTruthy();
  });
});

describe("an interceptor can deny each newly covered operation", () => {
  const denyKind =
    (kind: string, target?: string): RequestInterceptor =>
    (op, next) => {
      if (op.kind === kind && (target === undefined || op.target === target)) throw new AuthorizationError(`no ${kind}`);
      return next(op);
    };

  it("prompt: getPrompt rejects and the audit says denied", async () => {
    const audit: Array<{ kind: string; outcome: string }> = [];
    const { client } = await make([denyKind("prompt")], (e) => audit.push(e));
    await expect(client.getPrompt("greet", {}, "s")).rejects.toBeInstanceOf(AuthorizationError);
    expect(audit.find((e) => e.kind === "prompt")).toMatchObject({ kind: "prompt", target: "greet", outcome: "denied" });
  });

  it("skill: listSkills / getSkill / readSkillFile reject; the union omits a denied server", async () => {
    const { client } = await make([denyKind("skill")]);
    await expect(client.listSkills("s")).rejects.toBeInstanceOf(AuthorizationError);
    await expect(client.getSkill(ENTRY.uri, "s")).rejects.toBeInstanceOf(AuthorizationError);
    await expect(client.readSkillFile({ ...ENTRY, server: "s" } as never)).rejects.toBeInstanceOf(AuthorizationError);
    const errors: string[] = [];
    expect(await client.listSkills(undefined, { onError: (s) => errors.push(s) })).toEqual([]);
    expect(errors).toEqual(["s"]);
  });

  it("list: a denied catalog is empty in the sync view and rejects in discover()", async () => {
    const { client } = await make([denyKind("list", "tools")]);
    expect(client.listTools("s")).toEqual([]);
    expect(client.listPrompts("s").map((p) => p.name)).toEqual(["greet", "internal"]); // other catalogs unaffected
    await expect(client.discover("tools", "s")).rejects.toBeInstanceOf(AuthorizationError);
    expect(await client.discover("tools")).toEqual([]); // union: the denied server is left out
  });

  it("authorize(): a policy sees every new kind; 'approve' on a list never waits for a human", async () => {
    const kinds = new Set<string>();
    const onApprove = vi.fn();
    const { client } = await make([
      authorize((req) => {
        kinds.add(req.kind);
        return req.kind === "list" ? "approve" : req.kind === "prompt" && req.target === "internal" ? "deny" : "allow";
      }, { onApprove }),
    ]);
    expect(client.listTools("s")).toHaveLength(2); // approve => allowed through, no approver involved
    expect(onApprove).not.toHaveBeenCalled();
    await client.getPrompt("greet", {}, "s");
    await expect(client.getPrompt("internal", {}, "s")).rejects.toBeInstanceOf(AuthorizationError);
    await client.listSkills("s");
    expect([...kinds].sort()).toEqual(["list", "prompt", "skill"]);
  });
});

describe("old-style interceptors are unaffected", () => {
  it("one that only handles call/read/query passes the new kinds through untouched", async () => {
    const touched: string[] = [];
    const oldStyle: RequestInterceptor = async (op, next) => {
      if (op.kind === "call") {
        touched.push(op.target);
        return next(op);
      }
      return next(op);
    };
    const { client } = await make([oldStyle]);
    expect(client.listTools("s").map((t) => t.name)).toEqual(["echo", "secret"]);
    expect(client.listResources("s")).toHaveLength(2);
    expect(client.listPrompts("s")).toHaveLength(2);
    expect(await client.getPrompt("greet", { who: "z" }, "s")).toBeTruthy();
    expect(await client.listSkills("s")).toHaveLength(1);
    await client.callTool("s.echo", {});
    expect(touched).toEqual(["echo"]);
  });

  it("one that answers a list with a non-array is read as 'no opinion': the catalog shows as fetched", async () => {
    const sloppy: RequestInterceptor = async (op, next) => (op.kind === "list" ? undefined : next(op));
    const { client } = await make([sloppy]);
    expect(client.listTools("s")).toHaveLength(2);
    expect(await client.discover("prompts", "s")).toHaveLength(2);
  });

  it("rateLimit and circuitBreaker leave catalog views alone", async () => {
    const rl = rateLimit({ concurrency: 1 });
    const cb = circuitBreaker({ threshold: 1 });
    const { client } = await make([cb.interceptor, rl.interceptor]);
    expect(client.listTools("s")).toHaveLength(2);
    await client.getPrompt("greet", {}, "s");
  });
});

describe("listFilter and the synchronous view", () => {
  const keep = (_s: string, kind: string, name: string) => !(kind === "tool" && name === "secret") && !(kind === "prompt" && name === "internal") && name !== "mem://hidden";

  it("hides items and stamps _meta on the sync accessors and on discover()", async () => {
    const { client } = await make([listFilter({ keep, annotate: (_s, kind, name) => (kind === "tool" && name === "echo" ? { flagged: true } : undefined) })]);
    expect(client.listTools("s").map((t) => t.name)).toEqual(["echo"]);
    expect((client.listTools("s")[0] as { _meta?: unknown })._meta).toEqual({ flagged: true });
    expect(client.listResources("s").map((r) => r.uri)).toEqual(["mem://a"]);
    expect(client.listPrompts("s").map((p) => p.name)).toEqual(["greet"]);
    expect(client.listResourceTemplates("s")).toHaveLength(1); // templates are not filtered
    expect((await client.discover("tools", "s")).map((t) => t.name)).toEqual(["echo"]);
    expect((await client.discover("tools")).map((t) => t.server)).toEqual(["s"]);
    // the raw catalog still routes: a hidden tool is not unreachable by the router, only by policy
    expect(client.connection("s")!.tools.has("secret")).toBe(true);
  });

  it("is re-applied when the server's list changes, before subscribers are told", async () => {
    const { client, mock } = await make([listFilter({ keep })]);
    const seenAtNotify: string[][] = [];
    client.subscribeCapabilities((_s, kind) => {
      if (kind === "tools") seenAtNotify.push(client.listTools("s").map((t) => t.name));
    });
    mock.spec.tools = [...mock.spec.tools!, { name: "extra", handler: () => ({ content: [] }) }];
    await mock.notifyToolListChanged();
    await vi.waitFor(() => expect(seenAtNotify.length).toBeGreaterThan(0));
    expect(seenAtNotify.at(-1)).toEqual(["echo", "extra"]); // "secret" stays hidden; the new tool was vetted before the notification
  });

  it("discover() carries the caller's context so a per-principal policy can decide", async () => {
    const byPrincipal: RequestInterceptor = (op, next) => {
      const p = (op.context?.meta as { principal?: string } | undefined)?.principal;
      if (op.kind === "list" && op.context && p === "bad") throw new AuthorizationError("bad principal");
      return next(op);
    };
    const { client } = await make([byPrincipal]);
    expect(await client.discover("prompts", "s", { context: { meta: { principal: "good" } } })).toHaveLength(2);
    await expect(client.discover("prompts", "s", { context: { meta: { principal: "bad" } } })).rejects.toBeInstanceOf(AuthorizationError);
    // scope() binds the context for discover() and getPrompt() too
    const bad = client.scope({ meta: { principal: "bad" } });
    await expect(bad.discover("prompts", "s")).rejects.toBeInstanceOf(AuthorizationError);
    expect(await bad.getPrompt("greet", {}, "s")).toBeTruthy();
  });

  it("removeServer drops the vetted view and discover() on an unknown server throws", async () => {
    const { client } = await make([listFilter({ keep })]);
    await client.removeServer("s");
    expect(() => client.listTools("s")).toThrow();
    await expect(client.discover("tools", "s")).rejects.toThrow();
  });

  it("a view that has not been vetted yet shows nothing rather than an unvetted catalog (fails closed)", async () => {
    const mock = mkMock();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: RequestInterceptor = async (op, next) => {
      if (op.kind === "list") await gate;
      return next(op);
    };
    const client = new MCPClient({ servers: { s: { transport: mock.transport } }, interceptors: [slow] });
    opened.push(mock, client);
    const connecting = client.connect();
    await vi.waitFor(() => expect(client.connection("s")!.tools.size).toBe(2));
    expect(client.listTools("s")).toEqual([]);
    release();
    await connecting;
    expect(client.listTools("s")).toHaveLength(2);
  });
});
