import { describe, it, expect } from "vitest";
import {
  draftReducer,
  emptyDraft,
  assembleMessage,
  serializeArgs,
  resultToText,
  draftHasContent,
  type Draft,
  type ToolBlock,
} from "../src/draft.js";

describe("serializeArgs", () => {
  it("renders args compactly", () => {
    expect(serializeArgs({ a: 2, b: 3 })).toBe("a:2, b:3");
    expect(serializeArgs({ name: "alice", active: true })).toBe("name:alice, active:true");
    expect(serializeArgs({})).toBe("");
  });
  it("json-encodes nested values", () => {
    expect(serializeArgs({ obj: { x: 1 } })).toBe('obj:{"x":1}');
  });
});

describe("resultToText", () => {
  it("flattens an MCP content array", () => {
    const r = { content: [{ type: "text", text: "42" }] };
    expect(resultToText(r)).toBe("42");
  });
  it("joins multiple text blocks", () => {
    const r = { content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] };
    expect(resultToText(r)).toBe("a\nb");
  });
  it("handles ReadResourceResult contents", () => {
    const r = { contents: [{ uri: "mem://x", text: "hello" }] };
    expect(resultToText(r)).toBe("hello");
  });
  it("passes through plain strings", () => {
    expect(resultToText("plain")).toBe("plain");
  });
});

describe("assembleMessage", () => {
  it("interleaves text and a tool block into one grounded message", () => {
    const draft: Draft = {
      blocks: [
        { id: "t1", kind: "text", text: "here is the sum:" },
        {
          id: "tool1",
          kind: "tool",
          server: "everything",
          tool: "get-sum",
          args: { a: 2, b: 3 },
          result: { content: [{ type: "text", text: "42" }] },
        },
        { id: "t2", kind: "text", text: "thanks" },
      ],
    };
    expect(assembleMessage(draft)).toBe(
      "here is the sum:\n\n‹tool everything.get-sum(a:2, b:3)›\n42\n\nthanks",
    );
  });

  it("skips empty text blocks", () => {
    const draft: Draft = {
      blocks: [
        { id: "t1", kind: "text", text: "   " },
        { id: "t2", kind: "text", text: "real" },
      ],
    };
    expect(assembleMessage(draft)).toBe("real");
  });

  it("labels a tool block that has not been run", () => {
    const draft: Draft = {
      blocks: [
        { id: "tool1", kind: "tool", server: "s", tool: "t", args: {} } as ToolBlock,
      ],
    };
    expect(assembleMessage(draft)).toBe("‹tool s.t()›\n(not run)");
  });

  it("serializes a resource block", () => {
    const draft: Draft = {
      blocks: [
        {
          id: "r1",
          kind: "resource",
          server: "everything",
          uri: "mem://greeting",
          result: { contents: [{ uri: "mem://greeting", text: "hi" }] },
        },
      ],
    };
    expect(assembleMessage(draft)).toBe("‹resource everything mem://greeting›\nhi");
  });
});

describe("draftReducer", () => {
  it("adds a text block", () => {
    const d = draftReducer(emptyDraft(), { type: "addText", text: "hello" });
    expect(d.blocks).toHaveLength(1);
    expect(d.blocks[0]).toMatchObject({ kind: "text", text: "hello" });
  });

  it("adds a tool block and then removes it", () => {
    const block: ToolBlock = {
      id: "tool1",
      kind: "tool",
      server: "everything",
      tool: "get-sum",
      args: { a: 1, b: 1 },
      result: { content: [{ type: "text", text: "2" }] },
    };
    let d = draftReducer(emptyDraft(), { type: "addBlock", block });
    expect(d.blocks).toHaveLength(1);
    d = draftReducer(d, { type: "removeBlock", id: "tool1" });
    expect(d.blocks).toHaveLength(0);
  });

  it("patches a block (re-run updates result)", () => {
    const block: ToolBlock = {
      id: "tool1",
      kind: "tool",
      server: "everything",
      tool: "get-sum",
      args: { a: 1, b: 1 },
      result: { content: [{ type: "text", text: "2" }] },
    };
    let d = draftReducer(emptyDraft(), { type: "addBlock", block });
    d = draftReducer(d, { type: "patchBlock", id: "tool1", patch: { running: true } });
    expect((d.blocks[0] as ToolBlock).running).toBe(true);
    d = draftReducer(d, {
      type: "patchBlock",
      id: "tool1",
      patch: { running: false, result: { content: [{ type: "text", text: "3" }] } },
    });
    const updated = d.blocks[0] as ToolBlock;
    expect(updated.running).toBe(false);
    expect(resultToText(updated.result)).toBe("3");
  });

  it("setText only edits the matching text block", () => {
    let d = draftReducer(emptyDraft(), { type: "addText", text: "a" });
    const id = d.blocks[0]!.id;
    d = draftReducer(d, { type: "setText", id, text: "updated" });
    expect((d.blocks[0] as { text: string }).text).toBe("updated");
  });

  it("clear empties the draft", () => {
    let d = draftReducer(emptyDraft(), { type: "addText", text: "a" });
    d = draftReducer(d, { type: "clear" });
    expect(d.blocks).toHaveLength(0);
  });
});

describe("draftHasContent", () => {
  it("is false for empty / whitespace-only drafts", () => {
    expect(draftHasContent(emptyDraft())).toBe(false);
    expect(draftHasContent({ blocks: [{ id: "t", kind: "text", text: "  " }] })).toBe(false);
  });
  it("is true once a tool block has a result", () => {
    expect(
      draftHasContent({
        blocks: [
          {
            id: "tool1",
            kind: "tool",
            server: "s",
            tool: "t",
            args: {},
            result: { content: [{ type: "text", text: "x" }] },
          },
        ],
      }),
    ).toBe(true);
  });
});
