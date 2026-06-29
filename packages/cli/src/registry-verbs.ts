// The 8 tool verbs — each an umbrella over an existing tool package's `cli.ts`.
// Every entry lazily `import()`s the tool's CLI so we only pay its module cost when
// the verb is actually invoked, and so `mcpq --help` stays instant. Each loaded module
// exposes `run(argv: string[]): Promise<void>` (the shared CLI entry contract).

export interface ToolCli {
  run(argv: string[]): Promise<void>;
}

export interface ToolVerb {
  describe: string;
  load: () => Promise<ToolCli>;
}

export const registryVerbs: Record<string, ToolVerb> = {
  codegen: {
    describe: "Generate typed client code from a server's surface",
    load: () => import("../../mcp-query/src/codegen/cli.js"),
  },
  inspect: {
    describe: "Inspect a server's live capability surface",
    load: () => import("../../mcp-query/src/cli/inspect.js"),
  },
  contract: {
    describe: "Capture/diff a contract for drift detection (breaking vs compatible)",
    load: () => import("../../mcp-contract/src/cli.js"),
  },
  lint: {
    describe: "Lint a server's capability surface",
    load: () => import("../../mcp-lint/src/cli.js"),
  },
  docs: {
    describe: "Render Markdown reference docs for a server",
    load: () => import("../../mcp-docs/src/cli.js"),
  },
  bench: {
    describe: "Benchmark latency/throughput (with optional CI budgets)",
    load: () => import("../../mcp-bench/src/cli.js"),
  },
  record: {
    describe: "Record/replay offline fixtures for a server",
    load: () => import("../../mcp-record/src/cli.js"),
  },
  gate: {
    describe: "Runtime governance / policy gate for a server",
    load: () => import("../../mcp-gate/src/cli.js"),
  },
};

/** Tool verbs that own their own subcommands — leave their argv untouched. */
export const subcommandVerbs = new Set(["contract", "record"]);
