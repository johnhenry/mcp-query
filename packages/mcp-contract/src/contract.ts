// The contract model: a versioned snapshot of an MCP server's capability surface
// (tools + their input/output schemas + annotations, resources, templates, prompts),
// plus capture-from-a-live-server and a breaking-change classifier built on schema.ts.

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { diffSchema, type JSONSchema, type SchemaChange } from "./schema.js";

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ContractTool {
  name: string;
  description?: string;
  inputSchema?: JSONSchema;
  outputSchema?: JSONSchema;
  annotations?: ToolAnnotations;
}
export interface ContractResource {
  uri: string;
  name?: string;
  mimeType?: string;
}
export interface ContractTemplate {
  uriTemplate: string;
  name?: string;
}
export interface ContractPrompt {
  name: string;
  description?: string;
  arguments?: Array<{ name: string; required?: boolean }>;
}

export interface Contract {
  /** Contract format version. */
  version: 1;
  server?: { name?: string; version?: string };
  tools: ContractTool[];
  resources: ContractResource[];
  templates: ContractTemplate[];
  prompts: ContractPrompt[];
}

/** Capture the full capability surface of a *connected* SDK client into a contract. */
export async function captureContract(client: Client): Promise<Contract> {
  const caps = client.getServerCapabilities() ?? {};
  const info = client.getServerVersion();

  const tools: ContractTool[] = [];
  if (caps.tools) {
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      for (const t of page.tools) {
        tools.push({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema as JSONSchema | undefined,
          outputSchema: t.outputSchema as JSONSchema | undefined,
          annotations: t.annotations as ToolAnnotations | undefined,
        });
      }
      cursor = page.nextCursor;
    } while (cursor);
  }

  const resources: ContractResource[] = [];
  const templates: ContractTemplate[] = [];
  if (caps.resources) {
    const r = await client.listResources().catch(() => ({ resources: [] }));
    for (const x of r.resources) resources.push({ uri: x.uri, name: x.name, mimeType: x.mimeType });
    const t = await client.listResourceTemplates().catch(() => ({ resourceTemplates: [] }));
    for (const x of t.resourceTemplates) templates.push({ uriTemplate: x.uriTemplate, name: x.name });
  }

  const prompts: ContractPrompt[] = [];
  if (caps.prompts) {
    const p = await client.listPrompts().catch(() => ({ prompts: [] }));
    for (const x of p.prompts) {
      prompts.push({
        name: x.name,
        description: x.description,
        arguments: x.arguments?.map((a) => ({ name: a.name, required: a.required })),
      });
    }
  }

  // Stable ordering so contracts are diff-friendly in version control.
  const byName = <T extends { name?: string; uri?: string; uriTemplate?: string }>(a: T, b: T) =>
    String(a.name ?? a.uri ?? a.uriTemplate).localeCompare(String(b.name ?? b.uri ?? b.uriTemplate));

  return {
    version: 1,
    server: info ? { name: info.name, version: info.version } : undefined,
    tools: tools.sort(byName),
    resources: resources.sort(byName),
    templates: templates.sort(byName),
    prompts: prompts.sort(byName),
  };
}

export type ChangeCategory = "tool" | "resource" | "template" | "prompt";

export interface ContractChange {
  category: ChangeCategory;
  /** The id this change concerns (tool/prompt name, resource uri, template uri). */
  target: string;
  level: "breaking" | "compatible";
  detail: string;
}

export interface ContractDiff {
  changes: ContractChange[];
  breaking: number;
  compatible: number;
}

export interface DiffOptions {
  /**
   * Consumer-driven scoping: only report changes whose target matches one of these
   * (exact id or `*` glob). Omit to report the whole surface. New additions to the
   * surface (which are always compatible) are reported regardless.
   */
  used?: string[];
}

function globToRe(glob: string): RegExp {
  return new RegExp("^" + glob.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
}

/** Classify every change between two contracts (prev = pinned, next = live/candidate). */
export function diffContract(prev: Contract, next: Contract, opts: DiffOptions = {}): ContractDiff {
  const changes: ContractChange[] = [];
  const used = opts.used?.map(globToRe);
  const isUsed = (target: string) => !used || used.some((re) => re.test(target));

  diffCollection(prev.tools, next.tools, (t) => t.name, "tool", changes, (a, b, push) => {
    annotationChanges(a.annotations, b.annotations).forEach((d) => push("breaking", d));
    diffSchema(a.inputSchema, b.inputSchema, "in").forEach((c) => push(c.level, schemaDetail("input", c)));
    diffSchema(a.outputSchema, b.outputSchema, "out").forEach((c) => push(c.level, schemaDetail("output", c)));
  });

  diffCollection(prev.resources, next.resources, (r) => r.uri, "resource", changes, (a, b, push) => {
    if (a.mimeType !== b.mimeType) push("compatible", `mimeType ${a.mimeType ?? "?"} → ${b.mimeType ?? "?"}`);
  });

  diffCollection(prev.templates, next.templates, (t) => t.uriTemplate, "template", changes);

  diffCollection(prev.prompts, next.prompts, (p) => p.name, "prompt", changes, (a, b, push) => {
    const pa = new Map((a.arguments ?? []).map((x) => [x.name, x]));
    const pb = new Map((b.arguments ?? []).map((x) => [x.name, x]));
    for (const [name, arg] of pb) {
      const before = pa.get(name);
      if (!before) push(arg.required ? "breaking" : "compatible", arg.required ? `new required argument "${name}"` : `new optional argument "${name}"`);
      else if (!before.required && arg.required) push("breaking", `argument "${name}" became required`);
    }
  });

  const scoped = changes.filter((c) => c.level === "compatible" || isUsed(c.target));
  return {
    changes: scoped,
    breaking: scoped.filter((c) => c.level === "breaking").length,
    compatible: scoped.filter((c) => c.level === "compatible").length,
  };
}

function schemaDetail(which: string, c: SchemaChange): string {
  return `${which} ${c.path || "(root)"}: ${c.detail}`;
}

function annotationChanges(a: ToolAnnotations | undefined, b: ToolAnnotations | undefined): string[] {
  const out: string[] = [];
  // Policy-relevant flips: gaining destructive, or losing read-only, are breaking.
  if (!a?.destructiveHint && b?.destructiveHint) out.push("now flagged destructive");
  if (a?.readOnlyHint && !b?.readOnlyHint) out.push("no longer read-only");
  return out;
}

/** Generic add/remove/changed walk over a keyed collection. */
function diffCollection<T>(
  prev: T[],
  next: T[],
  key: (x: T) => string,
  category: ChangeCategory,
  changes: ContractChange[],
  onBoth?: (a: T, b: T, push: (level: "breaking" | "compatible", detail: string) => void) => void,
): void {
  const prevMap = new Map(prev.map((x) => [key(x), x]));
  const nextMap = new Map(next.map((x) => [key(x), x]));
  for (const [k, a] of prevMap) {
    const b = nextMap.get(k);
    if (!b) {
      changes.push({ category, target: k, level: "breaking", detail: "removed" });
      continue;
    }
    onBoth?.(a, b, (level, detail) => changes.push({ category, target: k, level, detail }));
  }
  for (const [k] of nextMap) {
    if (!prevMap.has(k)) changes.push({ category, target: k, level: "compatible", detail: "added" });
  }
}
