#!/usr/bin/env node
// Daemon entrypoint: spawned (detached) by the CLI client. Runs from TypeScript source via
// `tsx` like the rest of the monorepo (the client spawns `node --import tsx <this file>`).

import { runDaemon } from "./server.js";

runDaemon().catch((e) => {
  console.error(e);
  process.exit(1);
});
