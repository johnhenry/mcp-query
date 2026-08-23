import { describe, it, expect } from "vitest";
import { resourceTag, capsTag, serverTag, entityTag } from "@johnhenry/mcp-query";
import { listQueryKey, resourceQueryKey, tagToQueryKeyPrefix, toolResultQueryKey } from "../src/keys.js";

describe("key builders", () => {
  it("toolResultQueryKey", () => {
    expect(toolResultQueryKey("s1", "search", "h123")).toEqual(["mcp-query", "s1", "toolResult", "search", "h123"]);
  });
  it("resourceQueryKey", () => {
    expect(resourceQueryKey("s1", "mem://a")).toEqual(["mcp-query", "s1", "resource", "mem://a"]);
  });
  it("listQueryKey for every kind", () => {
    expect(listQueryKey("s1", "tools")).toEqual(["mcp-query", "s1", "toolList"]);
    expect(listQueryKey("s1", "resources")).toEqual(["mcp-query", "s1", "resourceList"]);
    expect(listQueryKey("s1", "prompts")).toEqual(["mcp-query", "s1", "promptList"]);
  });
});

describe("tagToQueryKeyPrefix", () => {
  it("translates resourceTag", () => {
    expect(tagToQueryKeyPrefix(resourceTag("s1", "mem://a"))).toEqual(["mcp-query", "s1", "resource", "mem://a"]);
  });
  it("translates capsTag for each kind", () => {
    expect(tagToQueryKeyPrefix(capsTag("s1", "tools"))).toEqual(["mcp-query", "s1", "toolList"]);
    expect(tagToQueryKeyPrefix(capsTag("s1", "resources"))).toEqual(["mcp-query", "s1", "resourceList"]);
    expect(tagToQueryKeyPrefix(capsTag("s1", "prompts"))).toEqual(["mcp-query", "s1", "promptList"]);
  });
  it("translates serverTag to a blunt server-wide prefix", () => {
    expect(tagToQueryKeyPrefix(serverTag("s1"))).toEqual(["mcp-query", "s1"]);
  });
  it("translates entityTag best-effort", () => {
    expect(tagToQueryKeyPrefix(entityTag("Issue", 1234))).toEqual(["mcp-query", "Issue", "1234"]);
  });
});
