// SEP-2243 routing headers (Mcp-Method / Mcp-Name / Mcp-Param-*), unit level: the x-mcp-header
// scan, value encoding, and the header-vs-body cross-check the gateway guard is built on.

import { describe, it, expect } from "vitest";
import {
  checkRoutingHeaders,
  decodeHeaderValue,
  encodeHeaderValue,
  nameFromBody,
  paramHeadersFor,
  routingFromBody,
  scanHeaderDecls,
} from "../src/core/routingHeaders.js";

const schema = {
  type: "object",
  properties: {
    region: { type: "string", "x-mcp-header": "Region" },
    retries: { type: "integer", "x-mcp-header": "Retries" },
    dry: { type: "boolean", "x-mcp-header": "Dry" },
    nested: { type: "object", properties: { zone: { type: "string", "x-mcp-header": "Zone" } } },
    free: { type: "string" },
  },
};
const hdrs = (o: Record<string, string>) => new Headers(o);

describe("scanHeaderDecls", () => {
  it("finds annotations on properties and nested properties", () => {
    const r = scanHeaderDecls(schema);
    expect(r.valid && r.decls.map((d) => [d.path.join("."), d.headerName, d.type])).toEqual([
      ["region", "Region", "string"],
      ["retries", "Retries", "integer"],
      ["dry", "Dry", "boolean"],
      ["nested.zone", "Zone", "string"],
    ]);
  });
  it.each([
    ["number type", { properties: { a: { type: "number", "x-mcp-header": "A" } } }],
    ["empty name", { properties: { a: { type: "string", "x-mcp-header": "" } } }],
    ["not a token", { properties: { a: { type: "string", "x-mcp-header": "A B" } } }],
    ["duplicate (case-insensitive)", { properties: { a: { type: "string", "x-mcp-header": "A" }, b: { type: "string", "x-mcp-header": "a" } } }],
    ["under items", { properties: { l: { type: "array", items: { type: "string", "x-mcp-header": "I" } } } }],
    ["under oneOf", { oneOf: [{ properties: { a: { type: "string", "x-mcp-header": "A" } } }] }],
    ["on the root", { type: "string", "x-mcp-header": "R" }],
  ])("rejects %s", (_n, s) => {
    expect(scanHeaderDecls({ type: "object", ...s }).valid).toBe(false);
  });
  it("treats a schema with no annotations as valid and empty", () => {
    expect(scanHeaderDecls({ type: "object" })).toEqual({ valid: true, decls: [] });
    expect(scanHeaderDecls(undefined)).toEqual({ valid: true, decls: [] });
  });
});

describe("value encoding", () => {
  it("leaves plain ASCII alone and base64-encodes everything else", () => {
    expect(encodeHeaderValue("us-west1")).toBe("us-west1");
    expect(encodeHeaderValue("Hello, 世界")).toBe("=?base64?SGVsbG8sIOS4lueVjA==?=");
    expect(encodeHeaderValue(" padded ")).toBe("=?base64?IHBhZGRlZCA=?=");
    expect(encodeHeaderValue("line1\nline2")).toBe("=?base64?bGluZTEKbGluZTI=?=");
    expect(encodeHeaderValue("=?base64?literal?=")).toBe("=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?=");
  });
  it("round-trips, and rejects a malformed sentinel", () => {
    for (const v of ["", "a b", "Hello, 世界", "=?base64?x?=", "tab\there"]) expect(decodeHeaderValue(encodeHeaderValue(v))).toBe(v);
    expect(decodeHeaderValue("=?base64?%%%?=")).toBeUndefined();
  });
  it("builds Mcp-Param headers for the annotated arguments that have a value", () => {
    expect(paramHeadersFor(schema, { region: "us", retries: 3, dry: false, nested: { zone: "a" }, free: "x" })).toEqual({
      "Mcp-Param-Region": "us",
      "Mcp-Param-Retries": "3",
      "Mcp-Param-Dry": "false",
      "Mcp-Param-Zone": "a",
    });
    expect(paramHeadersFor(schema, { region: null })).toEqual({});
    expect(paramHeadersFor({ properties: { a: { type: "number", "x-mcp-header": "A" } } }, { a: 1 })).toEqual({});
  });
});

describe("routingFromBody", () => {
  it("derives method, name and annotated values from the body", () => {
    expect(routingFromBody("tools/call", { name: "t", arguments: { region: "us", free: "x" } }, schema)).toEqual({ method: "tools/call", name: "t", params: { Region: "us" } });
    expect(routingFromBody("tasks/get", { taskId: "abc" })).toEqual({ method: "tasks/get", name: "abc" });
    expect(routingFromBody("events/list", {})).toEqual({ method: "events/list" });
    expect(nameFromBody("resources/read", { uri: "file:///a" })).toBe("file:///a");
  });
});

describe("checkRoutingHeaders", () => {
  const call = { method: "tools/call", params: { name: "t", arguments: { region: "us", retries: 3 } } };
  const ok = { "mcp-method": "tools/call", "mcp-name": "t", "mcp-param-region": "us", "mcp-param-retries": "3" };
  const check = (h: Record<string, string>, body = call, modern = true) => checkRoutingHeaders({ headers: hdrs(h), body, inputSchema: schema, modern });

  it("passes when headers agree with the body (names are case-insensitive, integers compare numerically)", () => {
    expect(check(ok)).toBeUndefined();
    expect(check({ ...ok, "mcp-param-retries": "3.0" })).toBeUndefined();
    expect(check({ ...ok, "mcp-name": encodeHeaderValue("t") })).toBeUndefined();
  });
  it("flags a wrong Mcp-Method, Mcp-Name and Mcp-Param, case-sensitively", () => {
    expect(check({ ...ok, "mcp-method": "tools/list" })).toMatch(/Mcp-Method/);
    expect(check({ ...ok, "mcp-method": "Tools/Call" })).toMatch(/Mcp-Method/);
    expect(check({ ...ok, "mcp-name": "other" })).toMatch(/Mcp-Name/);
    expect(check({ ...ok, "mcp-param-region": "eu" })).toMatch(/Mcp-Param-Region/);
    expect(check({ ...ok, "mcp-param-retries": "4" })).toMatch(/Mcp-Param-Retries/);
  });
  it("requires headers on a modern request only", () => {
    const { "mcp-param-region": _r, ...noParam } = ok;
    expect(check(noParam)).toMatch(/Mcp-Param-Region header is absent/);
    expect(check({}, call, true)).toMatch(/required Mcp-Method/);
    expect(check({}, call, false)).toBeUndefined();
    expect(check({ "mcp-method": "tools/call" }, call, true)).toMatch(/required Mcp-Name/);
  });
  it("flags a Mcp-Param header for an argument the body does not carry, and a bad sentinel", () => {
    expect(check({ ...ok, "mcp-param-dry": "true" })).toMatch(/Mcp-Param-Dry header is set but the body carries no value/);
    expect(check({ ...ok, "mcp-name": "=?base64?%%?=" })).toMatch(/invalid Base64/);
  });
  it("covers the tasks and events Mcp-Name sources", () => {
    expect(checkRoutingHeaders({ headers: hdrs({ "mcp-method": "tasks/get", "mcp-name": "t1" }), body: { method: "tasks/get", params: { taskId: "t2" } }, modern: true })).toMatch(/taskId/);
    expect(checkRoutingHeaders({ headers: hdrs({ "mcp-method": "events/poll" }), body: { method: "events/poll", params: { name: "e" } }, modern: true })).toMatch(/Mcp-Name header is absent/);
    expect(checkRoutingHeaders({ headers: hdrs({ "mcp-method": "events/list" }), body: { method: "events/list", params: {} }, modern: true })).toBeUndefined();
  });
});
