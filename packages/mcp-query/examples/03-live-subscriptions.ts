// 03 · Live subscriptions — subscribe to a resource; when the server pushes
// notifications/resources/updated, the cache invalidates automatically (no polling).
// Run: npx tsx examples/03-live-subscriptions.ts

import { MCPClient } from "../src/index.js";
import { MockMCPServer } from "../src/testing/mockServer.js";
import type { CacheKey } from "../src/index.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let temperature = 20;
const sensor = new MockMCPServer({
  resources: [{ uri: "sensor://temp", read: () => ({ text: `${temperature}C` }) }],
});

const client = new MCPClient({ servers: { sensor: { transport: sensor.transport } } });
await client.connect();

const key: CacheKey = { kind: "resource", server: "sensor", uri: "sensor://temp" };
const read = async () => ((await client.readResource("sensor://temp", { subscribe: true })) as { contents: { text: string }[] }).contents[0]?.text;

console.log("initial:", await read()); // 20C
console.log("server-side subscription registered:", sensor.subscribed.has("sensor://temp"));

// The device reports a new reading; the server pushes an update.
temperature = 25;
await sensor.notifyResourceUpdated("sensor://temp");
await sleep(10);

console.log("cache invalidated by push:", client.cache.isStale(key));
console.log("re-read reflects the change:", await read()); // 25C

await client.close();
