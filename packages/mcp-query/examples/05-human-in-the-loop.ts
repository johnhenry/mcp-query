// 05 · Human-in-the-loop — a server tool drives a multi-step interaction: it elicits
// input from the user, then requests sampling. The InteractionBroker queues both; here a
// driver loop plays the role a UI would (in React you'd render `useInteractions()`).
// Run: npx tsx examples/05-human-in-the-loop.ts

import { MCPClient, InteractionBroker } from "../src/index.js";
import { MockMCPServer } from "../src/testing/mockServer.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const broker = new InteractionBroker({ manualSampling: true }); // a human authors sampling replies

const server = new MockMCPServer({
  tools: [
    {
      name: "draft_greeting",
      handler: async (_args, ctx) => {
        const who = await ctx.elicit({
          message: "Who should I greet?",
          requestedSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
        });
        const name = (who.content as { name?: string })?.name ?? "friend";
        const reply = await ctx.sample({ messages: [{ role: "user", content: { type: "text", text: `Greet ${name}.` } }], maxTokens: 50 });
        return { content: [{ type: "text", text: reply.content.text ?? "" }] };
      },
    },
  ],
});

const client = new MCPClient({ servers: { greeter: { transport: server.transport } }, interactions: broker });
await client.connect();

const call = client.callTool("greeter.draft_greeting", {}) as Promise<{ content: { text: string }[] }>;

// Drive the approval queue the way a UI would, until the call settles.
let done = false;
void call.finally(() => (done = true));
while (!done) {
  const [it] = broker.list();
  if (it?.type === "elicitation") {
    console.log("→ server is eliciting:", (it.payload as { message: string }).message);
    broker.resolve(it.id, { action: "approve", content: { name: "Ada" } });
  } else if (it?.type === "sampling") {
    console.log("→ server wants a completion (manual:", it.manual, ")");
    broker.resolve(it.id, {
      action: "approve",
      editedResult: { role: "assistant", content: { type: "text", text: "Hello, Ada! 👋" }, model: "human", stopReason: "endTurn" },
    });
  }
  await sleep(5);
}

console.log("result:", (await call).content[0]?.text); // Hello, Ada! 👋
console.log("audit:", broker.auditLog().map((e) => `${e.type}:${e.outcome}`).join(", "));
await client.close();
