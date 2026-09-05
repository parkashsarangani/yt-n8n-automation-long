import type { WorkerDef, WorkerOutput } from "../runner.ts";
import {
  PACKAGE_CONTRACT_MARKER,
  repairGrowthPackageSelection,
  validateGrowthPackageSelection,
} from "../growth-package-contract.ts";

/**
 * Deterministic contract boundary between growth_packager and every expensive
 * downstream stage. The model chooses title/thumbnail families; this worker
 * derives the duplicated selected strings from those authoritative variants,
 * then rejects any relational defect that cannot be repaired safely.
 *
 * Keeping this as its own node is deliberate: a package defect can never be
 * misclassified as a watchability/script defect by unattended recovery, because
 * it fails at package_release before story/script/thumbnail work begins.
 */
export function makeGrowthPackageReleaseWorker(): WorkerDef {
  return {
    name: "growth_package_release",
    kind: "worker",
    version: "1",
    consumes: [{ schema_id: "growth_package", range: "^1", as: "package" }],
    produces: "growth_package",
    produces_version: "1.2.0",
    async execute(inputs, ctx): Promise<WorkerOutput> {
      const original = inputs["package"]!.payload;
      const { data, repairs } = repairGrowthPackageSelection(original);
      const errors = validateGrowthPackageSelection(data);
      if (errors.length > 0) {
        throw new Error(`growth package release blocked (${PACKAGE_CONTRACT_MARKER}): ${errors.join("; ")}`);
      }
      if (repairs.length > 0) {
        ctx.logger.warn(
          `[growth_package_release] canonicalized ${repairs.length} duplicated selection field(s): ` +
          repairs.map((repair) => `${repair.path}`).join(", "),
        );
      }
      return { payload: data };
    },
  };
}
