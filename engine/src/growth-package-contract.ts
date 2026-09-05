export type PackageFamily = "curiosity" | "conflict" | "reversal";

type GrowthVariant = {
  family?: unknown;
  title?: unknown;
  thumbnail_concept?: unknown;
};

type GrowthPackage = {
  selected_title?: unknown;
  selected_title_family?: unknown;
  selected_thumbnail_concept?: unknown;
  selected_thumbnail_family?: unknown;
  variants?: unknown;
  [key: string]: unknown;
};

export interface GrowthPackageRepair {
  path: "selected_title" | "selected_thumbnail_concept";
  from: unknown;
  to: string;
}

export function isPackageFamily(value: unknown): value is PackageFamily {
  return value === "curiosity" || value === "conflict" || value === "reversal";
}

/**
 * Relational package invariant that JSON Schema cannot express: the selected
 * title/thumbnail must be exact members of the variant family the model chose.
 * Exact membership is intentional; downstream consumers need one authoritative
 * click proposition, not a paraphrase that can drift independently.
 */
export function validateGrowthPackageSelection(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const p = payload as GrowthPackage;
  const variants = Array.isArray(p.variants)
    ? p.variants.filter((v): v is GrowthVariant => Boolean(v) && typeof v === "object")
    : [];
  const errors: string[] = [];
  const families = variants.map((v) => v.family).filter(isPackageFamily);

  for (const family of ["curiosity", "conflict", "reversal"] as const) {
    if (families.filter((v) => v === family).length !== 1) {
      errors.push(`expected exactly one ${family} variant`);
    }
  }

  const titleFamily = isPackageFamily(p.selected_title_family)
    ? p.selected_title_family
    : variants.find((v) => v.title === p.selected_title)?.family;
  const thumbnailFamily = isPackageFamily(p.selected_thumbnail_family)
    ? p.selected_thumbnail_family
    : variants.find((v) => v.thumbnail_concept === p.selected_thumbnail_concept)?.family;

  if (!isPackageFamily(titleFamily)) {
    errors.push("selected title has no resolvable package family");
  } else {
    const variant = variants.find((v) => v.family === titleFamily);
    if (!variant || variant.title !== p.selected_title) {
      errors.push(`selected title does not exactly match the ${titleFamily} variant`);
    }
  }

  if (!isPackageFamily(thumbnailFamily)) {
    errors.push("selected thumbnail has no resolvable package family");
  } else {
    const variant = variants.find((v) => v.family === thumbnailFamily);
    if (!variant || variant.thumbnail_concept !== p.selected_thumbnail_concept) {
      errors.push(`selected thumbnail does not exactly match the ${thumbnailFamily} variant`);
    }
  }

  return errors;
}

/**
 * The model chooses the family; code copies the already-produced member string.
 * This removes the fragile requirement that an LLM reproduce an existing title
 * or thumbnail concept byte-for-byte in a second field. The repair is deliberately
 * conservative: it does not invent families, variants, or missing member values.
 * Structural defects remain for schema/semantic validation to reject.
 */
export function repairGrowthPackageSelection(payload: unknown): {
  data: unknown;
  repairs: GrowthPackageRepair[];
} {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { data: payload, repairs: [] };
  }

  const p = payload as GrowthPackage;
  if (!Array.isArray(p.variants)) return { data: payload, repairs: [] };
  const variants = p.variants.filter((v): v is GrowthVariant => Boolean(v) && typeof v === "object");
  const out: GrowthPackage = { ...p };
  const repairs: GrowthPackageRepair[] = [];

  const repairMember = (
    familyValue: unknown,
    selectedKey: "selected_title" | "selected_thumbnail_concept",
    variantKey: "title" | "thumbnail_concept",
  ) => {
    if (!isPackageFamily(familyValue)) return;
    const matches = variants.filter((v) => v.family === familyValue);
    if (matches.length !== 1) return;
    const canonical = matches[0]?.[variantKey];
    if (typeof canonical !== "string" || canonical.length === 0) return;
    if (out[selectedKey] === canonical) return;
    repairs.push({ path: selectedKey, from: out[selectedKey], to: canonical });
    out[selectedKey] = canonical;
  };

  repairMember(p.selected_title_family, "selected_title", "title");
  repairMember(p.selected_thumbnail_family, "selected_thumbnail_concept", "thumbnail_concept");

  return { data: repairs.length > 0 ? out : payload, repairs };
}

/**
 * Pure preflight for the reasoning-agent boundary. A duplicated selected string
 * is not a reason to spend another model call when the declared family makes the
 * correction deterministic. Validate the would-be released value without
 * mutating the provider payload; the release worker is the only transformation
 * allowed to materialize that correction as a new artifact.
 */
export function validateGrowthPackageReleaseability(payload: unknown): string[] {
  const { data } = repairGrowthPackageSelection(payload);
  return validateGrowthPackageSelection(data);
}

export const PACKAGE_CONTRACT_MARKER = "PACKAGE_CONTRACT";

export function isPackageContractFailureMessage(error: string): boolean {
  return error.includes(PACKAGE_CONTRACT_MARKER);
}

export function classifyWatchabilityReleaseFailure(
  failures: Array<{ node_id: string; error: string }>,
): "package_contract" | "creative" | null {
  const releaseFailures = failures.filter((failure) => failure.node_id === "watchability_release");
  if (releaseFailures.length === 0) return null;
  if (releaseFailures.some((failure) => isPackageContractFailureMessage(failure.error))) {
    return "package_contract";
  }
  return "creative";
}
