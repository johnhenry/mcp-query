// Browser-safe entry for mcp-record. Resolved in place of ./index.ts by bundlers that set the
// `browser` export condition (Vite, webpack, esbuild --platform=browser do this by default for
// a client build; see the `browser` key under `.` in package.json).
//
// Everything the library API needs (cassettes, `recordTransport`, `replayServer`,
// `replayTransport`, hashing) is free of Node-only modules, so this re-exports the Node entry
// unchanged. It is a separate file so a Node-only export added to ./index.ts later cannot leak
// into browser bundles unnoticed: test/browser.test.ts bundles THIS file for a browser platform
// and fails if any `node:` builtin or Node-only package is pulled in. Node-only code (the CLI,
// file I/O) lives in ./cli.ts and is never imported from here.
export * from "./index.js";
