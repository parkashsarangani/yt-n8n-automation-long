import contract from "./semantic-representation.json" with { type: "json" };
export type RepresentationMode = keyof typeof contract;
export type SceneBlueprint = (typeof contract)[RepresentationMode][number];
export const SEMANTIC_REPRESENTATION_CONTRACT: Readonly<Record<RepresentationMode, readonly SceneBlueprint[]>> = contract;
export function semanticBlueprintFitsMode(mode: string, blueprint: string): boolean {
  return Object.prototype.hasOwnProperty.call(contract, mode)
    && (contract[mode as RepresentationMode] as readonly string[]).includes(blueprint);
}
