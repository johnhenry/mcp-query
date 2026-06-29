// Lint rules — absolute, single-version *quality* checks over an MCP capability surface.
// Complementary to mcp-contract (which checks *drift* between two versions): lint asks
// "is this surface well-designed?", contract asks "did it change incompatibly?". Both run
// on the same captured Contract.

import type { Contract, ContractTool } from "../../mcp-contract/src/contract.js";

export type Severity = "error" | "warn" | "off";

export interface Rule {
  id: string;
  description: string;
  defaultSeverity: Severity;
  /** Return one entry per violation; severity is applied by the linter. */
  check: (c: Contract) => Array<{ target: string; message: string }>;
}

// Heuristic verb detection over tool names (matches kebab/snake/camel segment boundaries).
const READ = /(^|[-_/]|\b)(get|list|read|search|fetch|find|query|describe|count)([-_/]|s\b|\b|[A-Z])/i;
const DESTRUCTIVE = /(^|[-_/]|\b)(delete|remove|drop|destroy|truncate|purge|reset|revoke|wipe)([-_/]|\b|[A-Z])/i;

function undocumentedProps(t: ContractTool): string[] {
  const props = t.inputSchema?.properties;
  if (!props) return [];
  return Object.entries(props)
    .filter(([, s]) => !(s as { description?: string }).description?.trim())
    .map(([k]) => k);
}

function convention(name: string): string | null {
  if (name.includes("-")) return "kebab-case";
  if (name.includes("_")) return "snake_case";
  if (/[a-z][A-Z]/.test(name)) return "camelCase";
  return null; // single lowercase word — ambiguous, ignore
}

export const RULES: Rule[] = [
  {
    id: "tool-description",
    description: "Every tool has a non-empty description.",
    defaultSeverity: "error",
    check: (c) => c.tools.filter((t) => !t.description?.trim()).map((t) => ({ target: t.name, message: "tool has no description" })),
  },
  {
    id: "tool-input-described",
    description: "Each tool input property has a description.",
    defaultSeverity: "warn",
    check: (c) => c.tools.flatMap((t) => undocumentedProps(t).map((p) => ({ target: t.name, message: `input "${p}" has no description` }))),
  },
  {
    id: "destructive-annotation",
    description: "Tools whose name implies deletion set destructiveHint.",
    defaultSeverity: "warn",
    check: (c) =>
      c.tools
        .filter((t) => DESTRUCTIVE.test(t.name) && t.annotations?.destructiveHint !== true)
        .map((t) => ({ target: t.name, message: "name implies a destructive action but destructiveHint is not set" })),
  },
  {
    id: "read-only-annotation",
    description: "Read-style tools set readOnlyHint.",
    defaultSeverity: "warn",
    check: (c) =>
      c.tools
        .filter((t) => READ.test(t.name) && t.annotations?.readOnlyHint !== true && t.annotations?.destructiveHint !== true)
        .map((t) => ({ target: t.name, message: "name implies a read-only action but readOnlyHint is not set" })),
  },
  {
    id: "no-open-input",
    description: "Tool inputs are typed (no additionalProperties: true).",
    defaultSeverity: "warn",
    check: (c) =>
      c.tools
        .filter((t) => t.inputSchema?.additionalProperties === true)
        .map((t) => ({ target: t.name, message: "input schema allows arbitrary additionalProperties (untyped)" })),
  },
  {
    id: "resource-mime-type",
    description: "Resources declare a mimeType.",
    defaultSeverity: "warn",
    check: (c) => c.resources.filter((r) => !r.mimeType).map((r) => ({ target: r.uri, message: "resource has no mimeType" })),
  },
  {
    id: "prompt-description",
    description: "Prompts have a description.",
    defaultSeverity: "warn",
    check: (c) => c.prompts.filter((p) => !p.description?.trim()).map((p) => ({ target: p.name, message: "prompt has no description" })),
  },
  {
    id: "naming-consistency",
    description: "Tool names use a single naming convention.",
    defaultSeverity: "warn",
    check: (c) => {
      const conventions = new Set(c.tools.map((t) => convention(t.name)).filter((x): x is string => !!x));
      return conventions.size > 1 ? [{ target: "(server)", message: `tool names mix conventions: ${[...conventions].sort().join(", ")}` }] : [];
    },
  },
];
