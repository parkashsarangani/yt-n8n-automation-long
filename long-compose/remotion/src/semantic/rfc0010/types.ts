/** Mirror of engine/src/semantic-scene.ts. The packages build separately. */
export type Rfc0010SceneKind =
  | "scale_comparison"
  | "timeline"
  | "process"
  | "cause_chain"
  | "branching"
  | "comparison"
  | "before_after"
  | "relationship_graph"
  | "sequence"
  | "quantity"
  | "kinetic_phrase";

export interface Rfc0010Marker {
  id: string;
  label: string;
  value: number;
  rate_label?: string;
  time_label?: string;
  retained?: boolean;
}

export interface Rfc0010Axis { label: string; unit: string; max: number }
export interface Rfc0010Node { id: string; label: string; sub_label?: string; retained?: boolean }
export interface Rfc0010Edge { from: string; to: string; label?: string; retained?: boolean }
export interface Rfc0010PhraseLine { text: string; emphasis: boolean }

export interface Rfc0010Scene {
  kind: Rfc0010SceneKind;
  sequence_id?: string;
  continuation?: boolean;
  caption: string;
  axis?: Rfc0010Axis;
  markers?: Rfc0010Marker[];
  equation?: string;
  nodes?: Rfc0010Node[];
  edges?: Rfc0010Edge[];
  steps?: Rfc0010Node[];
  before?: Rfc0010Node;
  after?: Rfc0010Node;
  items?: Rfc0010Marker[];
  lines?: Rfc0010PhraseLine[];
}
