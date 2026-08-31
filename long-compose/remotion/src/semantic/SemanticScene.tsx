// semantic-representation.json has two other copies: engine/src/semantic-representation.json
// and the canonical contracts/semantic-representation.json. All three must stay byte-for-byte
// identical -- engine and this package build as separate, isolated Docker contexts, so neither
// can import the other's copy at build time. contracts/motion-visual-identity.test.ts asserts
// all three match on every PR, in the fast contracts CI job. Edit contracts/semantic-representation.json
// first, then copy it here and to engine's copy -- editing this file alone will fail that check.
import type {SceneBlueprint,SemanticSceneProps} from "./types";import {BG} from "./shared";import {semanticRegistry} from "./semantic-registry";import semanticContract from "./semantic-representation.json";
export * from "./types";
export const SUPPORTED_SEMANTIC_BLUEPRINTS=new Set<SceneBlueprint>(Object.keys(semanticRegistry) as SceneBlueprint[]);
export function semanticBlueprintFitsMode(mode?:string,b?:string){return !!mode&&!!b&&Object.prototype.hasOwnProperty.call(semanticContract,mode)&&(semanticContract as Record<string,string[]>)[mode]!.includes(b)}
export function SemanticScene(x:SemanticSceneProps){const valid=!!x.sceneBlueprint&&SUPPORTED_SEMANTIC_BLUEPRINTS.has(x.sceneBlueprint)&&semanticBlueprintFitsMode(x.representationMode,x.sceneBlueprint),hasActions=(x.semanticActionWindows?.length||0)>0;const effective:SceneBlueprint=valid&&(x.sceneBlueprint==="animated-statement"||hasActions)?x.sceneBlueprint!:"animated-statement";const Renderer=semanticRegistry[effective];return <div data-semantic-renderer="true" data-semantic-effective-blueprint={effective} style={{width:"100%",minHeight:540,display:"grid",placeItems:"center",background:`radial-gradient(ellipse at 50% 48%,#16324A55 0%,${BG}00 65%)`}}><Renderer {...x} sceneBlueprint={effective}/></div>}
