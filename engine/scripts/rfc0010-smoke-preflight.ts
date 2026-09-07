import { resolveSmokeModels, runSmoke } from "./freellmapi-smoke.ts";

async function main(): Promise<void> {
  const result = await runSmoke({ models: resolveSmokeModels() });
  console.log(
    `[rfc0010-smoke-preflight] routed via ${result.routedVia} (model ${result.model}); ` +
    `${result.skipped.length} earlier model(s) skipped`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
