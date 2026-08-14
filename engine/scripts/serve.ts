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
import { VidGenService } from "../src/service.ts";
import { createUiServer } from "../src/server.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const allowPublish = process.argv.includes("--publish") || process.env["AMOS_ALLOW_PUBLISH"] === "1";
const port = Number(process.env["AMOS_PORT"] ?? 4321);

// Loopback by default. In a container this must be 0.0.0.0 to be reachable at
// all — the loopback guarantee then comes from publishing the port as
// 127.0.0.1:4321:4321 on the host, plus the Host-header check in the server.
const host = process.env["AMOS_HOST"] ?? "127.0.0.1";

const service = await VidGenService.create({
  root: ROOT,
  allowPublish,
  ...(process.env["AMOS_DATA"] ? { dataDir: process.env["AMOS_DATA"] } : {}),
  ...(process.env["AMOS_ENV_FILE"] ? { envFile: process.env["AMOS_ENV_FILE"] } : {}),
});
const server = createUiServer({ service, uiDir: path.join(ROOT, "ui"), port, host });
const url = await server.listen();

console.log(`VidGen UI  ${url}${host === "0.0.0.0" ? "  (published on the host as 127.0.0.1:" + port + ")" : ""}`);
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
