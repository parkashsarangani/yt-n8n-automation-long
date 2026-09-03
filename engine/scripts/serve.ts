/**
 * Local control UI.
 *
 *   npm run ui              # http://127.0.0.1:4321
 *   npm run ui -- --publish # allow real YouTube uploads
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { VidGenService } from "../src/service.ts";
import { createUiServer } from "../src/server.ts";
import { startGrowthScheduler } from "../src/growth-scheduler.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const allowPublish = process.argv.includes("--publish") || process.env["AMOS_ALLOW_PUBLISH"] === "1";
const port = Number(process.env["AMOS_PORT"] ?? 4321);
const host = process.env["AMOS_HOST"] ?? "127.0.0.1";

const service = await VidGenService.create({
  root: ROOT,
  allowPublish,
  ...(process.env["AMOS_DATA"] ? { dataDir: process.env["AMOS_DATA"] } : {}),
  ...(process.env["AMOS_ENV_FILE"] ? { envFile: process.env["AMOS_ENV_FILE"] } : {}),
});

// RFC 0009: unattended production is candidate-tournament orchestration, not
// merely "start one topic every 24h". The dedicated scheduler can abandon a
// creatively weak top candidate and advance to the next ranked package while
// refusing to paper over technical/QA failures by changing topic.
const scheduler = startGrowthScheduler(service);

const server = createUiServer({ service, scheduler, uiDir: path.join(ROOT, "ui"), port, host });
const url = await server.listen();

console.log(`VidGen UI  ${url}${host === "0.0.0.0" ? "  (published on the host as 127.0.0.1:" + port + ")" : ""}`);
console.log(`config     ${service.envFile}`);

console.log("\nwhat will actually run:");
const stages = service.capabilities();
for (const s of stages) {
  console.log(`  ${s.real ? "✓" : "✗"} ${s.label.padEnd(30)} ${s.provider}`);
  if (!s.real) {
    console.log(`      ${s.consequence}`);
    console.log(`      fix: ${s.blockedBy ?? `set ${s.missing.join(" + ")}`}`);
  }
}

const degraded = stages.filter((s) => !s.real).length;
console.log(degraded === 0 ? "\n  every stage is live." : `\n  ${degraded} of ${stages.length} stages will use a stand-in.`);

if (allowPublish) console.log("  !! --publish is on: QA-passing runs may upload publicly");
else console.log("  publishing is a dry run; restart with --publish to upload for real");

console.log("\nscheduled jobs:");
for (const j of scheduler.status()) {
  console.log(`  ${j.enabled ? "on " : "off"} ${j.id.padEnd(9)} every ${String(j.every_hours).padStart(3)}h  ${j.description}`);
}
if (scheduler.status().some((j) => j.id === "produce" && j.enabled)) {
  console.log(
    "\n  !! auto-production is ON: discovery ranks packages; a creative failure may advance to the next candidate.\n" +
    "     technical/QA failures do not trigger topic substitution.",
  );
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    scheduler.stop();
    void server.close().then(() => process.exit(0));
  });
}
