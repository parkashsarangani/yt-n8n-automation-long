import { readFile } from "node:fs/promises";
import path from "node:path";
import type { WorkerDef, WorkerOutput } from "../runner.ts";

/**
 * Load the recurring cast for unattended cartoon production.
 *
 * The cast is operator-owned configuration, not a creative model output. Daily
 * scheduled runs use CARTOON_CAST_PATH when supplied; otherwise they use the
 * packaged config/cast.default.json so a clean deployment remains runnable.
 * Explicit /api/runs/cartoon calls may still provide a different roster through
 * the separate cartoon graph.
 */
export function makeCastLoaderWorker(): WorkerDef {
  return {
    name: "cast_loader",
    kind: "worker",
    version: "1",
    consumes: [],
    produces: "cast_roster",
    produces_version: "1.1.0",

    async execute(_inputs, ctx): Promise<WorkerOutput> {
      const configured = process.env["CARTOON_CAST_PATH"]?.trim();
      const file = path.resolve(configured || path.join(process.cwd(), "config", "cast.default.json"));

      let raw: string;
      try {
        raw = await readFile(file, "utf8");
      } catch (err) {
        const source = configured ? "CARTOON_CAST_PATH" : "packaged default cast";
        throw new Error(
          `could not read ${source} (${file}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      let payload: unknown;
      try {
        payload = JSON.parse(raw);
      } catch (err) {
        throw new Error(
          `cast roster is not valid JSON (${file}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const characters = (payload as { characters?: unknown } | null)?.characters;
      if (!Array.isArray(characters) || characters.length === 0) {
        throw new Error(`cast roster (${file}) must contain a non-empty characters[] array`);
      }

      ctx.logger.log(`[cast_loader] loaded ${characters.length} recurring character(s) from ${file}`);
      return { payload };
    },
  };
}
