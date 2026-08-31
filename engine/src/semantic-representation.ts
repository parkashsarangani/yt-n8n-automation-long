// This JSON file has two other copies: long-compose/remotion/src/semantic/
// semantic-representation.json (the renderer, a separate npm package that
// cannot import across the engine/long-compose Docker-context boundary --
// see .github/workflows/ci.yml) and contracts/semantic-representation.json
// (the canonical copy). All three must stay byte-for-byte identical, and
// contracts/motion-visual-identity.test.ts asserts exactly that on every PR,
// in the fast contracts CI job that runs before either Docker image builds.
// Edit contracts/semantic-representation.json first, then copy it here and
// to the renderer's copy -- editing this file alone will fail that check.
import contract from "./semantic-representation.json" with { type: "json" };
export type RepresentationMode = keyof typeof contract;
export type SceneBlueprint = (typeof contract)[RepresentationMode][number];
export const SEMANTIC_REPRESENTATION_CONTRACT: Readonly<Record<RepresentationMode, readonly SceneBlueprint[]>> = contract;
export function semanticBlueprintFitsMode(mode: string, blueprint: string): boolean {
  return Object.prototype.hasOwnProperty.call(contract, mode)
    && (contract[mode as RepresentationMode] as readonly string[]).includes(blueprint);
}
