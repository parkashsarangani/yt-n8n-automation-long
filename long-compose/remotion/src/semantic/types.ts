export type RepresentationMode="concrete-scene"|"domain-model"|"quantitative"|"spatial"|"temporal"|"kinetic-text";
export type SceneBlueprint="container-object"|"molecular-system"|"lattice"|"particle-system"|"flow-system"|"cross-section"|"mass-volume-comparison"|"scale-comparison"|"before-after-object"|"map"|"timeline"|"animated-statement";
export type SemanticActionWindow={actor:string;action:string;target:string;startRatio:number;endRatio:number;aligned:boolean};
export type SemanticEntity={entity_id:string;label:string;aliases?:string[];depiction:{kind:string;appearance:string;color:string;shape?:string;material?:string;formula?:string;geometry?:string}};
export interface SemanticSceneProps{representationMode?:RepresentationMode;sceneBlueprint?:SceneBlueprint;visualClaim?:string;semanticActionWindows?:SemanticActionWindow[];semanticEntities?:SemanticEntity[];elements?:string[];before?:string;after?:string;keyText?:string;numericValue?:number|null}
