import { readFile } from "node:fs/promises";
import path from "node:path";
import type { WorkerDef, WorkerOutput } from "../runner.ts";

/**
 * Load the recurring cast for unattended cartoon production.
 *
 * The cast is operator-owned configuration, not a creative model output. Daily
 * scheduled runs therefore load one stable roster from CARTOON_CAST_PATH while
 * explicit /api/runs/cartoon calls may still provide a different roster as a
 * graph input.
 */
export function makeCastLoaderWorker(): WorkerDef {
  return {
    name: "cast_loader",
    kind: "worker",
    version: "1",
    consumes: [],
    produces: "cast_roster",
    produces_version: "1.2.0",

    async execute(_inputs, ctx): Promise<WorkerOutput> {
      const configured = process.env["CARTOON_CAST_PATH"]?.trim();
      if (!configured) {
        throw new Error(
          "scheduled cartoon production requires CARTOON_CAST_PATH pointing to a cast_roster JSON file",
        );
      }

      const file = path.resolve(configured);
      let raw: string;
      try {
        raw = await readFile(file, "utf8");
      } catch (err) {
        throw new Error(
          `could not read CARTOON_CAST_PATH (${file}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      let payload: unknown;
      try {
        payload = JSON.parse(raw);
      } catch (err) {
        throw new Error(
          `CARTOON_CAST_PATH is not valid JSON (${file}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const characters = (payload as { characters?: unknown } | null)?.characters;
      if (!Array.isArray(characters) || characters.length === 0) {
        throw new Error(`CARTOON_CAST_PATH (${file}) must contain a non-empty characters[] array`);
      }

      ctx.logger.log(`[cast_loader] loaded ${characters.length} recurring character(s) from ${file}`);
      return { payload };
    },
  };
}
