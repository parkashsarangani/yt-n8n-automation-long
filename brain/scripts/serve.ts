/**
 * Local control UI.
 *
 *   npm run ui              # http://127.0.0.1:4321
 *   npm run ui -- --publish # allow real YouTube uploads (still private)
 *
 * Loopback-only and unauthenticated by design: it holds API keys, so it must
 * never be bound to a routable interface.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { AmosService } from "../src/service.ts";
import { createUiServer } from "../src/server.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const allowPublish = process.argv.includes("--publish");
const port = Number(process.env["AMOS_PORT"] ?? 4321);

const service = await AmosService.create({ root: ROOT, allowPublish });
const server = createUiServer({ service, uiDir: path.join(ROOT, "ui"), port });
const url = await server.listen();

console.log(`AMOS UI  ${url}`);
console.log(`config   ${service.envFile}`);
for (const p of service.providerSummary()) {
  console.log(`  ${p.role.padEnd(10)} ${p.provider}${p.real ? "" : "  (fake)"}`);
}
if (allowPublish) console.log("\n  !! --publish is on: approved runs will upload to YouTube as PRIVATE");
else console.log("\n  publishing is a dry run; restart with --publish to upload for real");

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void server.close().then(() => process.exit(0));
  });
}
