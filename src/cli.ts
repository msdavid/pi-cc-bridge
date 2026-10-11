import { runDaemon } from "./bridge.ts";

runDaemon().catch(error => {
  process.stderr.write(`pi-cc-bridge: ${(error as Error).message}\n`);
  process.exit(1);
});
