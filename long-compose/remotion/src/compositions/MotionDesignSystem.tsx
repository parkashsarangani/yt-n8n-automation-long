import React from "react";
import { Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

export type SubjectPrimitive = "particles" | "rays" | "wave" | "horizon" | "spectrum" | "path" | "shells" | "objects";
export type RelationshipPrimitive =
  | "network" | "hierarchy" | "one-to-many" | "many-to-one" | "facets-around-center"
  | "overlapping-sets" | "nested-context" | "cycle" | "cause-chain" | "before-after"
  | "map" | "timeline" | "quantity" | "spectrum" | "physical-transformation";
export type VisualPrimitive = SubjectPrimitive | RelationshipPrimitive;
export type VisualOperation = "stack" | "timeline" | "counter" | "compress" | "group" | "sort" | "scale-compare" | "payoff";
export type VisualState = "hypothesis" | "contradiction" | "mechanism" | "qualification" | "payoff";
export type CompositionMode = "bookend" | "full-model" | "reaction";

export const MOTION_COMPATIBILITY: Record<VisualOperation, readonly VisualPrimitive[] | readonly ["*"]> = {
  stack: ["particles", "objects", "hierarchy", "nested-context", "quantity", "shells"],
  timeline: ["timeline", "cause-chain", "path", "map", "rays", "wave", "spectrum", "cycle", "particles"],
  counter: ["quantity", "particles", "objects"],
  compress: ["particles", "objects", "many-to-one", "physical-transformation", "before-after", "shells"],
  group: ["network", "one-to-many", "many-to-one", "facets-around-center", "overlapping-sets", "nested-context", "particles", "objects"],
  sort: ["objects", "hierarchy", "quantity", "timeline"],
  "scale-compare": ["before-after", "physical-transformation", "spectrum", "quantity", "objects", "overlapping-sets"],
  payoff: ["*"],
};

const PAPER = "#F7F4EA";
const ACCENT = "#FFD166";
const BLUE = "#65C7F7";
const GREEN = "#7DE2A8";
const RED = "#FF7D7D";
const BG = "#08101E";
const clamp = { extrapolateLeft: "clamp" as const, extrapolateRight: "clamp" as const };

const palette: Record<VisualState, { line: string; fill: string; muted: string }> = {
  hypothesis: { line: "#E8B96A", fill: "#3B2E22", muted: "#A78966" },
  contradiction: { line: RED, fill: "#3B2029", muted: "#9B6070" },
  mechanism: { line: BLUE, fill: "#16324A", muted: "#517C9B" },
  qualification: { line: "#B794F4", fill: "#2D2546", muted: "#75669B" },
  payoff: { line: GREEN, fill: "#183B32", muted: "#5A9A84" },
};

function useProgress() {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const setup = interpolate(frame, [0, Math.max(1, durationInFrames * 0.16)], [0, 1], clamp);
  const transform = interpolate(frame, [durationInFrames * 0.14, durationInFrames * 0.78], [0, 1], { ...clamp, easing: Easing.inOut(Easing.cubic) });
  const consequence = interpolate(frame, [durationInFrames * 0.72, durationInFrames * 0.9], [0, 1], clamp);
  const hold = interpolate(frame, [durationInFrames * 0.9, durationInFrames], [0, 1], clamp);
  const pop = (delay = 0) => spring({ frame: frame - delay * fps, fps, config: { damping: 16, stiffness: 92 } });
  // Keep a low-amplitude living hold after the main transformation so a
  // diagram never becomes a frozen slide while the final clause is spoken.
  const living = Math.sin(frame / Math.max(1, fps) * Math.PI * 2) * 0.5 + 0.5;
  return { setup, transform, consequence, hold, living, pop };
}

// Wraps into at most two lines, sized to the pill's actual available width
// rather than a fixed character count. A label that still overflows past two
// lines folds its remainder into the second line with an ellipsis instead of
// being dropped outright: the audit's real finding here was that "collision
// resolution" meant deleting the label -- the pill vanished entirely, not
// repositioned or abbreviated -- and a viewer sees no explanation at all
// where one was authored. An ellipsis still tells them what the scene is
// about; a blank space where a label should be tells them nothing.
//
// The bug that made this worse than the audit even realized: the original
// (and my first pass at this rewrite) wrote `lines[lines.length - 1] = word`
// unconditionally. When `lines` is still empty that's `lines[-1] = word` --
// which does not push a real element, since arrays only grow for
// non-negative integer indices -- so the FIRST word of every label was
// silently swallowed on the very next word's turn. A two-word label like
// "cause chain" rendered as just "chain". Caught by actually rendering a
// frame and looking at it, not by the perceptual test, which only checks
// that *some* bright pixels exist in the cell.
// Exported so tests can pin its behaviour directly rather than only through a
// full Chrome render -- the bug this function's history documents (see
// comment below) was invisible to every test that only checked the render
// pipeline end-to-end.
export const labelLines = (text: string, maxChars: number): string[] => {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const lines: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    const current = lines.length ? lines[lines.length - 1]! : "";
    if (!current || `${current} ${word}`.length <= maxChars) {
      if (lines.length) lines[lines.length - 1] = `${current} ${word}`;
      else lines.push(word);
      continue;
    }
    if (lines.length < 2) {
      lines.push(word);
      continue;
    }
    const rest = words.slice(i).join(" ");
    const combined = `${lines[1]} ${rest}`;
    lines[1] = combined.length <= maxChars ? combined : `${combined.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
    break;
  }
  return lines;
};

function Label({ text, x, y, active = false, state, maxWidth = 300 }: { text?: string; x: number; y: number; active?: boolean; state: VisualState; maxWidth?: number }) {
  if (!text) return null;
  const colors = palette[state];
  // ~0.56em per character at this weight; derived from maxWidth so a wider
  // pill (a full-model scene) actually wraps later than a narrow one (a dense
  // row slot), instead of every pill wrapping at the same fixed character
  // count regardless of how much room it was actually given.
  const lines = labelLines(text, Math.max(10, Math.floor((maxWidth - 38) / (54 * 0.56))));
  if (!lines.length) return null;
  const longest = Math.max(...lines.map((line) => line.length));
  const fontSize = Math.max(47, Math.min(54, (maxWidth - 38) / Math.max(4, longest) * 1.72));
  const width = Math.min(maxWidth, Math.max(150, longest * fontSize * 0.58 + 44));
  const height = lines.length === 2 ? 96 : 72;
  return <g transform={`translate(${x} ${y})`}>
    <rect x={-width / 2} y={-height / 2} width={width} height={height} rx="22" fill={active ? colors.fill : "#0B1424"} stroke={active ? colors.line : colors.muted} strokeWidth={active ? 4 : 2} />
    <text textAnchor="middle" fill={PAPER} fontSize={fontSize} fontWeight="820">
      {lines.map((line, index) => <tspan key={`${line}-${index}`} x="0" y={(index - (lines.length - 1) / 2) * fontSize * 1.02 + fontSize * 0.34}>{line}</tspan>)}
    </text>
  </g>;
}

const hashText = (text: string) => Array.from(text).reduce((hash, char) => ((hash * 31 + char.charCodeAt(0)) >>> 0), 2166136261);

// entity_id -> a real icon resolved server-side (engine/src/icon-search.ts,
// via Iconify's open icon search) for that entity's label. Keyed by the same
// identityKeys/label id EntityMark already uses for its hash-picked shape --
// see the entityIcons prop threaded down from MotionDesignSystem below.
export type EntityIconMap = Record<string, { viewBox: string; body: string }>;

// The authored topology between a scene's entities (explanation_plan@1.5.0
// model_relations, compiled by cartoon-scenes-v16). `from`/`to` are indices
// into the scene's `elements` array as the COMPILER cleaned it -- the
// renderer caps and de-duplicates that list again for display, so indices
// are remapped once more before they reach Geometry (see visibleRelations).
export interface ModelRelation {
  from: number;
  to: number;
  kind: string;
}

export const RELATION_KINDS = ["causes", "blocks", "becomes", "feeds", "contains"] as const;

// Six silhouettes (not four) so a viewer tracking several entities across a
// crowded network/timeline sees genuinely distinct marks rather than the same
// four shapes repeating and reading as generic "pills and nodes". Hexagon and
// plus were picked specifically because their outlines differ from the
// existing circle/diamond/triangle/ring at a glance, even at small size.
//
// `icon`, when present, replaces the arbitrary hash-picked shape with a real
// icon (still tinted with the hash-picked colour, so an entity keeps the same
// colour identity whether or not this particular scene resolved an icon for
// it, and whether it cuts to an AI-generated shot that only ever gets the
// colour/shape as a text hint -- see motion-visual-identity.ts). A viewer
// watching a "water molecule" node now sees an actual droplet instead of a
// hexagon that means nothing; an entity with no confident icon match keeps
// today's shape exactly as before, this is a strict addition, never a
// regression on a miss.
export function EntityMark({ id, label, x, y, size = 30, active = true, icon, color }: { id: string; label?: string; x: number; y: number; size?: number; active?: boolean; icon?: { viewBox: string; body: string }; color?: string }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const hash = hashText(id || "entity");
  const colors = [ACCENT, BLUE, GREEN, "#B794F4", "#FF7D7D", "#5DE0C6"];
  // `color` overrides the hash-derived palette entirely -- used by the
  // payoff mechanism chain (ExplanationScene.tsx) to force every icon green,
  // matching the established "payoff-state geometry is always green" visual
  // language (see the accentCopyBlocks test in motion-design-render.test.js)
  // instead of occasionally landing on the same accent gold as the closing
  // text purely by hash coincidence, which a live test run caught reading as
  // a second, duplicated block of closing copy.
  const fill = color ?? colors[hash % colors.length]!;
  const opacity = active ? 1 : 0.25;
  if (icon) {
    return <svg x={x - size} y={y - size} width={size * 2} height={size * 2} viewBox={icon.viewBox} opacity={opacity} overflow="visible">
      {/* Iconify's own body markup, sanitized engine-side before this ever
          reaches an artifact (icon-search.ts). fill="currentColor" in that
          markup resolves against this <g>'s color attribute, so the icon
          picks up the same hash-derived colour. */}
      <g color={fill} dangerouslySetInnerHTML={{ __html: icon.body }} />
    </svg>;
  }

  // No icon resolved for this entity.
  //
  // This used to draw a hash-picked polygon -- a circle, diamond, triangle,
  // hexagon, ring or cross, in a hash-picked colour. For a concrete noun that
  // Iconify can match, the real icon carries meaning. For everything else
  // ("vacuum gap", "empty separation", "heat loss") the viewer got a red
  // cross or a purple hexagon that stood for nothing: decoration shaped like
  // information, which is worse than drawing nothing, because it invites the
  // viewer to decode a symbol that has no meaning to decode.
  //
  // The entity's own words are always relevant, so show those instead, as a
  // mark in the entity's identity colour rather than a caption pill. The
  // colour still comes from the same hash, so an entity keeps one consistent
  // identity across scenes whether it resolved an icon or not.
  const text = (label ?? "").trim();
  if (!text) return null;
  const enter = spring({ frame, fps, config: { damping: 18, stiffness: 110 } });
  const lines = labelLines(text, 15);
  const longest = Math.max(1, ...lines.map((line) => line.length));
  const fontSize = Math.max(26, Math.min(44, size * 1.2));
  const rule = Math.min(340, longest * fontSize * 0.56);
  return <g transform={`translate(${x} ${y}) scale(${0.86 + enter * 0.14})`} opacity={opacity * Math.min(1, enter * 1.5)}>
    <text textAnchor="middle" fill={fill} fontSize={fontSize} fontWeight="850">
      {lines.map((line, index) => (
        <tspan key={`${line}-${index}`} x="0" y={(index - (lines.length - 1) / 2) * fontSize * 1.04 + fontSize * 0.34}>{line}</tspan>
      ))}
    </text>
    {/* A short rule under the words keeps the mark reading as one object in
        the diagram rather than as loose floating text. */}
    <rect x={-rule / 2} y={(lines.length - 1) / 2 * fontSize * 1.04 + fontSize * 0.62} width={rule * enter} height={5} rx={2.5} fill={fill} opacity={0.5} />
  </g>;
}

// A diagram gets at most one central label plus two supporting labels. Watch
// feedback on a rendered episode found the opposite problem from an earlier
// audit round: four simultaneous labels read as competing clutter, even
// though each one individually had a collision-free slot. One entity mattering
// more than the others is also just true of most explanations -- a cause
// chain has a beginning and an end that carry the weight; the middle steps
// are what the geometry (edges, motion) is for. The uncaptioned entities keep
// their EntityMark shape/colour, so the viewer still sees all of them; they
// just aren't all narrated in text at once.
const MAX_LABELS = 3;

// Primitives whose geometry draws one mark PER authored entity (a funnel's
// sources, a chain's steps, a tree's leaves) rather than a fixed pair. These
// need every authored entity to survive the entity cap, or the diagram
// silently renders an incomplete model -- and each dropped entity also loses
// its resolved Iconify icon. MAX_LABELS still separately governs how many of
// them get a visible TEXT label.
const MULTI_ENTITY_PRIMITIVES = new Set<string>([
  "cause-chain", "timeline", "many-to-one", "one-to-many", "hierarchy", "network", "objects", "cycle",
  // Added when these primitives learned to draw one mark per authored entity.
  // Leaving them out capped every one of them at TWO entities, so the third
  // entity a scene authored was discarded before Geometry ever saw it -- the
  // new per-entity code could not have drawn it however correct it was. Found
  // by rendering a real episode scene and noticing "heat loss" was absent
  // from a diagram whose plan clearly named it.
  "nested-context", "shells", "rays", "path", "facets-around-center", "overlapping-sets",
]);

// Three fixed, non-overlapping slots -- a peak and two flanking positions --
// rather than tying a label to its operated entity: an operation like payoff
// can move two entities to the same x, which would stack two labels exactly
// on top of each other if the slot followed the entity instead of the row.
//
// The flanking slots were originally +/-270 from center (x=270/810). A real
// "full-model" render (compositionMode zooms the whole diagram to 126%,
// scale(compositionScale) in ExplanationScene) showed the right flanking
// label ("softened starch") clipped at the frame edge -- content that close
// to the unscaled viewBox edge gets pushed outside the visible canvas once
// the 126% zoom is applied. Pulled both flanking slots in toward center for
// margin against that zoom.
const DENSE_SLOTS = [
  { x: 540, y: 340 },
  { x: 330, y: 436 },
  { x: 750, y: 436 },
] as const;
const denseLabelSlot = (index: number) => DENSE_SLOTS[index] ?? DENSE_SLOTS[2]!;

function DirectedEdge({ x1, y1, x2, y2, progress, state, curved = false }: {
  x1: number; y1: number; x2: number; y2: number; progress: number; state: VisualState; curved?: boolean;
}) {
  const colors = palette[state];
  const length = Math.max(1, Math.hypot(x2 - x1, y2 - y1));
  const dash = state === "hypothesis" ? "14 12" : `${length}`;
  const offset = state === "hypothesis" ? 0 : length * (1 - progress);
  const d = curved ? `M${x1} ${y1} Q540 ${Math.min(y1, y2) - 90} ${x2} ${y2}` : `M${x1} ${y1} L${x2} ${y2}`;
  return <path d={d} fill="none" stroke={colors.line} strokeWidth="6" strokeLinecap="round"
    strokeDasharray={dash} strokeDashoffset={offset} markerEnd="url(#motion-arrow)" opacity={0.22 + progress * 0.78} />;
}

// A connection that says WHAT it asserts, not merely that two things touch.
//
// Every relationship primitive previously drew one undifferentiated
// DirectedEdge for every connection, so "the valve blocks backflow" and "the
// pump drives backflow" rendered as the identical arrow. Opposition in
// particular was undrawable: the diagram asserted the opposite of the
// narration. Each kind below is separated STRUCTURALLY (where the stroke
// stops, whether it carries an arrowhead, whether it keeps moving), not by
// colour alone, so the distinction survives the muted/greyscale palettes and
// a viewer who is not studying the frame.
function RelationEdge({ x1, y1, x2, y2, progress, state, kind, phase = 0 }: {
  x1: number; y1: number; x2: number; y2: number; progress: number; state: VisualState; kind: string; phase?: number;
}) {
  const colors = palette[state];
  const length = Math.max(1, Math.hypot(x2 - x1, y2 - y1));
  const ux = (x2 - x1) / length;
  const uy = (y2 - y1) / length;

  if (kind === "blocks") {
    // The stroke stops short and is barred. An edge that lands on the target
    // with an arrowhead would state that the target IS reached -- exactly
    // backwards. The remainder continues as a faint dashed ghost so the
    // viewer can still see what was being reached for.
    const stopX = x1 + ux * length * 0.6;
    const stopY = y1 + uy * length * 0.6;
    return <g>
      <path d={`M${x1} ${y1} L${stopX} ${stopY}`} fill="none" stroke={RED} strokeWidth="6" strokeLinecap="round"
        strokeDasharray={`${length}`} strokeDashoffset={length * (1 - progress)} opacity={0.3 + progress * 0.7} />
      <path d={`M${stopX + ux * 34} ${stopY + uy * 34} L${x2} ${y2}`} fill="none" stroke={colors.muted} strokeWidth="5"
        strokeLinecap="round" strokeDasharray="7 13" opacity={0.34 * progress} />
      <path d={`M${stopX - uy * 27} ${stopY + ux * 27} L${stopX + uy * 27} ${stopY - ux * 27}`} stroke={RED}
        strokeWidth="10" strokeLinecap="round" opacity={progress} />
    </g>;
  }

  if (kind === "contains") {
    // Containment is not travel between two points. An arrow would read as
    // "A causes B"; a ring drawn around the target, tethered to the source,
    // reads as enclosure.
    const radius = 54 + progress * 5;
    return <g opacity={0.28 + progress * 0.72}>
      <circle cx={x2} cy={y2} r={radius} fill="none" stroke={colors.line} strokeWidth="5" strokeDasharray="4 10" />
      <path d={`M${x1} ${y1} L${x2 - ux * radius} ${y2 - uy * radius}`} fill="none" stroke={colors.muted} strokeWidth="5"
        strokeLinecap="round" strokeDasharray={`${length}`} strokeDashoffset={length * (1 - progress)} />
    </g>;
  }

  if (kind === "feeds") {
    // Continuous supply rather than a single event. `phase` is driven by the
    // living clock, so this is the one edge kind still visibly moving after
    // progress reaches 1 -- which is precisely the difference between
    // "feeds" and "causes", and it also keeps the frame alive during the
    // hold instead of freezing into a slide.
    return <g>
      <path d={`M${x1} ${y1} L${x2} ${y2}`} fill="none" stroke={colors.line} strokeWidth="5" strokeLinecap="round"
        strokeDasharray={`${length}`} strokeDashoffset={length * (1 - progress)} opacity={0.22 + progress * 0.5} />
      {[0, 0.34, 0.68].map((offset, i) => {
        const t = (phase + offset) % 1;
        return <circle key={i} cx={x1 + ux * length * t} cy={y1 + uy * length * t} r={9} fill={ACCENT}
          opacity={progress * (0.3 + 0.7 * Math.sin(t * Math.PI))} />;
      })}
    </g>;
  }

  if (kind === "becomes") {
    // The same thing at two times, so the edge itself shows a transition:
    // the source half stays provisional (dashed), the target half is drawn
    // as asserted. A plain arrow would read as transfer between two separate
    // entities instead of one entity changing.
    const midX = (x1 + x2) / 2;
    const midY = (y1 + y2) / 2;
    const half = length / 2;
    return <g opacity={0.25 + progress * 0.75}>
      <path d={`M${x1} ${y1} L${midX} ${midY}`} fill="none" stroke={colors.muted} strokeWidth="6" strokeLinecap="round" strokeDasharray="10 10" />
      <path d={`M${midX} ${midY} L${x2} ${y2}`} fill="none" stroke={colors.line} strokeWidth="7" strokeLinecap="round"
        strokeDasharray={`${half}`} strokeDashoffset={half * (1 - progress)} markerEnd="url(#motion-arrow)" />
    </g>;
  }

  return <DirectedEdge x1={x1} y1={y1} x2={x2} y2={y2} progress={progress} state={state} />;
}

function Dot({ x, y, r = 28, fill = BLUE, opacity = 1 }: { x: number; y: number; r?: number; fill?: string; opacity?: number }) {
  return <circle cx={x} cy={y} r={r} fill={fill} opacity={opacity} />;
}

type Point = [number, number];

function operatePoint(base: Point, index: number, total: number, operation: VisualOperation, progress: number): Point {
  let target: Point = base;
  if (operation === "stack") {
    target = [420 + (index % 6) * 48, 430 - Math.floor(index / 6) * 48];
  } else if (operation === "group") {
    const center: Point = index % 2 === 0 ? [350, 245] : [730, 245];
    target = [center[0] + ((index * 37) % 120) - 60, center[1] + ((index * 53) % 150) - 75];
  } else if (operation === "sort") {
    const rank = total - 1 - index;
    target = [170 + (rank % 5) * 185, 115 + Math.floor(rank / 5) * 115];
  } else if (operation === "compress") {
    target = [540 + (base[0] - 540) * 0.32, 245 + (base[1] - 245) * 0.38];
  } else if (operation === "scale-compare") {
    const left = index < total / 2;
    target = [left ? 260 + (base[0] % 180) : 710 + (base[0] % 230), 245 + (base[1] - 245) * (left ? 0.58 : 1.12)];
  } else if (operation === "payoff") {
    const angle = total > 1 ? index / total * Math.PI * 2 : 0;
    target = [540 + Math.cos(angle) * 160, 245 + Math.sin(angle) * 125];
  }
  return [
    base[0] + (target[0] - base[0]) * progress,
    base[1] + (target[1] - base[1]) * progress,
  ];
}

function cubicPoint(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const u = 1 - t;
  return [
    u*u*u*p0[0] + 3*u*u*t*p1[0] + 3*u*t*t*p2[0] + t*t*t*p3[0],
    u*u*u*p0[1] + 3*u*u*t*p1[1] + 3*u*t*t*p2[1] + t*t*t*p3[1],
  ];
}

type GeometryProps = {
  primitive: VisualPrimitive;
  operation: VisualOperation;
  state: VisualState;
  labels: string[];
  identityKeys: string[];
  entityIcons?: EntityIconMap;
  before: string;
  after: string;
  keyText: string;
  numericValue: number | null;
  relations: ModelRelation[];
  progress: number;
  living: number;
  pop: (delay?: number) => number;
};

// The authored relation graph: the scene's own entities in labelled slots,
// joined by exactly the connections the plan asserted.
//
// Extracted from the `network` branch so any primitive can fall back to it.
// A composition that draws the wrong claim is worse than a plain graph that
// draws the right one.
function RelationGraph({ labels, identityKeys, entityIcons, relations, state, progress, living, pop }: {
  labels: string[]; identityKeys: string[]; entityIcons?: EntityIconMap; relations: ModelRelation[];
  state: VisualState; progress: number; living: number; pop: (delay?: number) => number;
}) {
  // Suppressed when the mark itself had to fall back to text -- otherwise the
  // same phrase is printed twice, once as the mark and once as its caption.
  const captionFor = (index: number) => {
    const key = identityKeys[index] || labels[index] || `entity-${index}`;
    return entityIcons?.[key] ? (labels[index] ?? "") : "";
  };
    const count = Math.min(labels.length, 4);
    // Explicit slots per entity count, NOT operatePoint. A first render of
    // this branch laid the entities on an ellipse and then passed them
    // through operatePoint like every other primitive -- and `group`
    // promptly relocated all of them onto its two fixed cluster centres,
    // collapsing the authored graph into an illegible knot in the middle
    // third of the frame. operatePoint exists to rearrange interchangeable
    // marks; here the positions ARE the content, so the operation must not
    // be allowed to overwrite them. Progression instead comes from the
    // nodes easing out of the centre into their slots below, which reads as
    // the model assembling itself.
    //
    // The slots are widely separated and label-aware: each has room for a
    // caption directly beneath it without colliding with any other node,
    // any other caption, or the 510-tall frame edge.
    const LAYOUTS: Record<number, Point[]> = {
      2: [[290, 215], [790, 215]],
      3: [[540, 118], [265, 345], [815, 345]],
      4: [[275, 118], [805, 118], [275, 345], [805, 345]],
    };
    const slots = LAYOUTS[count] ?? LAYOUTS[4]!;
    // Ease from the centre outward. `settle` reaches 1 well before the
    // scene ends so the edges are drawn against a stable graph rather than
    // chasing moving endpoints.
    const settle = Math.min(1, progress * 1.6);
    const nodes: Point[] = slots.slice(0, count).map(([sx, sy]) => [
      540 + (sx - 540) * settle,
      245 + (sy - 245) * settle,
    ]);
    const nodeRadius = 52;
    return <>
      {relations.map((relation, i) => {
        const from = nodes[relation.from];
        const to = nodes[relation.to];
        if (!from || !to) return null;
        // Stop each edge short of both marks so the stroke -- and, for
        // `blocks`, its bar -- never sits underneath an icon where it
        // cannot be read.
        const span = Math.max(1, Math.hypot(to[0] - from[0], to[1] - from[1]));
        const ux = (to[0] - from[0]) / span;
        const uy = (to[1] - from[1]) / span;
        if (span <= nodeRadius * 2) return null;
        // `contains` draws a ring AROUND its target rather than an edge
        // that stops at it, so it needs the mark's true centre. Handing it
        // the same inset endpoint as every other kind put the enclosure
        // ring half a node off to one side, visibly ringing empty canvas
        // beside the thing it was supposed to be containing (caught on a
        // render, not from reading the code).
        const targetInset = relation.kind === "contains" ? 0 : nodeRadius;
        return <RelationEdge key={`${relation.from}-${relation.to}-${relation.kind}`}
          x1={from[0] + ux * nodeRadius} y1={from[1] + uy * nodeRadius}
          x2={to[0] - ux * targetInset} y2={to[1] - uy * targetInset}
          progress={Math.max(0, Math.min(1, progress * 1.35 - 0.15 - i * 0.1))} state={state} kind={relation.kind} phase={living} />;
      })}
      {nodes.map(([x, y], i) => {
        const eid = identityKeys[i] || labels[i] || `entity-${i}`;
        return <EntityMark key={i} id={eid} icon={entityIcons?.[eid]} x={x} y={y} size={40 + pop(i * .06) * 10} />;
      })}
      {/* Every node gets its caption, deliberately past MAX_LABELS. That
          cap guards against captions competing for the same space, which
          is a real risk when a primitive's label slots are fixed and its
          marks move. Here the slots above are chosen so each caption has
          its own reserved band -- and an unlabeled node inside a graph the
          planner explicitly authored is a hole in the explanation, not
          restraint. */}
      {nodes.map(([x, y], i) => (
        // +104, not the ~70 a caption would normally sit at. A live
        // render showed the pill overlapping its own mark, and covering the
        // bottom half of a `contains` ring so enclosure read as a broken
        // arc. The offset has to clear the largest thing drawn ON a node,
        // which is that ring, not the mark.
        // Above the node in the upper half, below it in the lower half.
        // Always-below put the top node's caption straight across the edges
        // leaving that node -- a render showed a `blocks` bar sitting on top
        // of the caption of the very entity doing the blocking.
        <Label key={`label-${i}`} text={captionFor(i)} x={x} y={y < 245 ? y - 82 : y + 104} active={i === 0} state={state} maxWidth={300} />
      ))}
    </>;
}

function Geometry({ primitive, operation, state, labels, identityKeys, entityIcons, before, after, keyText, numericValue, relations, progress, living, pop }: GeometryProps) {
  const colors = palette[state];
  // Only forward matches count. Reversing an edge to find a match would draw
  // the causality backwards, which misinforms the viewer more thoroughly than
  // drawing nothing -- so an unauthored direction falls back to the neutral
  // "causes" styling rather than borrowing the reverse edge's kind.
  const kindBetween = (from: number, to: number): string =>
    relations.find((relation) => relation.from === from && relation.to === to)?.kind ?? "causes";
  // The authored relation between two entities REGARDLESS of which way round
  // it was written, so a branch that has a fixed idea of which end is the
  // "source" can still draw the claim in its true direction. kindBetween
  // deliberately refuses to match backwards -- it returns a kind, and a kind
  // applied to a reversed edge states the opposite claim. This returns the
  // whole relation so the caller can orient the edge correctly instead.
  const relationBetween = (a: number, b: number) =>
    relations.find((relation) => (relation.from === a && relation.to === b) || (relation.from === b && relation.to === a));
  // Every authored entity, addressable by index, with its identity key and
  // resolved icon already paired up.
  //
  // Most primitives used to reach for `identityKeys[0] || labels[0]` and draw
  // that one thing, discarding everything else the plan authored. A scene
  // that named "vacuum gap", "conduction" and "heat loss" rendered four
  // nested rectangles and the words "vacuum gap" -- two thirds of the model
  // silently absent, and the same picture for every scene that happened to
  // pick the same primitive. This makes "draw all of them" the cheap option.
  const entityCount = Math.min(4, Math.max(labels.length, identityKeys.length));
  // Some branches only carry an identity key. The text fallback needs the
  // words that key stands for.
  const labelOf = (key: string) => {
    const index = identityKeys.indexOf(key);
    return index >= 0 ? labels[index] : labels[labels.indexOf(key)] ?? key;
  };
  const entity = (index: number) => {
    const label = labels[index] ?? "";
    const id = identityKeys[index] || label || `entity-${index}`;
    return { id, label, icon: entityIcons?.[id] };
  };

  // When the authored relations CONTRADICT the primitive's own composition,
  // the relations win.
  //
  // nested-context, shells and overlapping-sets all draw containment or
  // membership -- boxes inside boxes, rings inside rings, sets that overlap.
  // That is the right picture when a scene's relations are `contains`. It is
  // an actively WRONG picture when they are `blocks` or `causes`: a real
  // episode (run_a41a8e2e) drew "vacuum gap BLOCKS conduction, conduction
  // CAUSES heat loss" as three nested boxes, which asserts that heat loss
  // contains conduction contains the vacuum gap. The exact opposite of the
  // claim, drawn confidently, in four separate scenes that all looked alike.
  // A viewer who reads that picture learns something false.
  //
  // Drawing a plain relation graph instead is less decorative and more
  // honest: it can render a barred `blocks` edge, which is the entire point
  // of those scenes. Scenes whose relations really are containment keep
  // their nesting, so this narrows the vocabulary only where it was lying.
  const CONTAINMENT_PRIMITIVES = new Set(["nested-context", "shells", "overlapping-sets"]);
  const hasDirectionalRelation = relations.some((relation) => relation.kind !== "contains");
  if (hasDirectionalRelation && CONTAINMENT_PRIMITIVES.has(primitive) && entityCount >= 2) {
    return <RelationGraph labels={labels} identityKeys={identityKeys} entityIcons={entityIcons}
      relations={relations} state={state} progress={progress} living={living} pop={pop} />;
  }
  const commonStroke = { fill: "none", stroke: colors.line, strokeWidth: 7, strokeLinecap: "round" as const, strokeDasharray: state === "hypothesis" ? "15 12" : undefined };

  if (primitive === "particles") {
    // Every other primitive separates hypothesis from contradiction
    // structurally, via dashed strokes on provisional geometry. Particles had
    // only a palette change, so two states rendered with identical structure:
    // invisible to a perceptual comparison, and weak for a viewer too.
    const provisional = state === "hypothesis";
    const broken = state === "contradiction";
    // Iconify integration (#173) only ever reached objects/network/
    // cause-chain/timeline/before-after -- particles was still 28 identical
    // flat-colour dots regardless of whether the scene meant stars, cells,
    // people, or votes. "many-instance systems" genuinely are many of the
    // SAME thing, so one representative icon repeated 28 times is the
    // semantically correct treatment here (not 28 different icons, which
    // particles was never meant to depict) -- falls back to the existing
    // hash-derived shape, uniformly, when no icon resolved.
    const repId = identityKeys[0] || labels[0] || "particle";
    const repIcon = entityIcons?.[repId];
    return <>{Array.from({ length: 28 }, (_, i) => {
      const base: Point = [105 + (i % 7) * 142, 82 + Math.floor(i / 7) * 110];
      const [ox, oy] = operatePoint(base, i, 28, operation, progress);
      // Contradiction scatters the particles that carried the failed guess, so
      // the break reads in the arrangement rather than only in the colour.
      const x = ox + (broken ? Math.sin(i * 2.1) * 34 * progress : 0);
      const y = oy + (broken ? Math.cos(i * 1.7) * 26 * progress : 0);
      const activated = operation !== "counter" || i < Math.ceil(28 * progress);
      const radius = (10 + pop(i * 0.025) * 13) * (activated ? 1 : 0.52);
      const opacity = activated ? 0.3 + progress * 0.7 : 0.12;
      const fill = i % 4 === 0 ? ACCENT : colors.line;
      // Hypothesis draws the same particles as unfilled dashed rings: present,
      // but not yet asserted. Kept as plain strokes even with an icon
      // available -- "not yet asserted" is a structural signal an icon fill
      // would undercut.
      if (provisional) {
        return <circle key={i} cx={x} cy={y} r={radius} fill="none" stroke={fill} strokeWidth="3" strokeDasharray="6 6" opacity={opacity} />;
      }
      return <g key={i} opacity={opacity}><EntityMark id={repId} label={labels[0]} icon={repIcon} x={x} y={y} size={radius + living * 1.5} /></g>;
    })}</>;
  }
  if (primitive === "rays") {
    // A source reaching named targets, when the plan named any. The old
    // version drew one mark and six anonymous rays into empty canvas, so two
    // rays scenes about completely different things were identical frames.
    if (entityCount >= 2) {
      const source = entity(0);
      const targetSlots: Point[] = [[860, 108], [905, 245], [860, 382]];
      const targets = Array.from({ length: entityCount - 1 }, (_, i) => i + 1);
      const sourceX = 235;
      return <>
        {targets.map((entityIndex, i) => {
          const [tx, ty] = targetSlots[targets.length === 1 ? 1 : i] ?? targetSlots[1]!;
          const target = entity(entityIndex);
          // A rays scene has a natural source at the centre, but the plan is
          // free to author the relation the other way round -- "silvered wall
          // BLOCKS infrared" runs target->source. Drawing that as a
          // source->target arrow states the opposite of the claim, so the
          // edge is oriented by what was actually authored.
          const relation = relationBetween(0, entityIndex);
          const reversed = relation ? relation.from === entityIndex : false;
          // Both ends are inset well clear of the marks: an entity with no
          // icon renders as WORDS, and an arrowhead landing in the middle of
          // a word is unreadable (a render put one squarely through "silvered
          // wall").
          const near: Point = [sourceX + 96, 245];
          const far: Point = [tx - 104, ty];
          const [x1, y1] = reversed ? far : near;
          const [x2, y2] = reversed ? near : far;
          return <React.Fragment key={entityIndex}>
            {/* The ray carries the authored relation: a `blocks` edge shows the
                beam stopping short, which is the whole point of a scene about
                something reflecting radiation back. */}
            <RelationEdge x1={x1} y1={y1} x2={x2} y2={y2}
              progress={Math.max(0, Math.min(1, progress * 1.3 - i * 0.12))} state={state}
              kind={relation?.kind ?? "causes"} phase={living} />
            <EntityMark id={target.id} label={target.label} icon={target.icon} x={tx} y={ty} size={34} />
            <Label text={target.icon ? target.label : ""} x={tx} y={ty + 62} active={i === 0} state={state} maxWidth={260} />
          </React.Fragment>;
        })}
        <EntityMark id={source.id} label={source.label} icon={source.icon} x={sourceX} y={245} size={58 + living * 3} />
        <Label text={source.icon ? source.label : ""} x={sourceX} y={245 + 84} active state={state} maxWidth={280} />
      </>;
    }
    const ends: Array<[number, number]> = [[100,90],[70,245],[110,420],[970,85],[1010,245],[970,420]];
    const eid = identityKeys[0] || labels[0] || "source";
    return <><EntityMark id={eid} label={labelOf(eid)} icon={entityIcons?.[eid]} x={540} y={245} size={58}/>{ends.map(([x,y],i)=><DirectedEdge key={i} x1={540} y1={245} x2={x} y2={y} progress={Math.max(0,progress-i*.07)} state={state}/>)}</>;
  }
  if (primitive === "wave") {
    const amplitude = 35 + progress * 65;
    const points = Array.from({length:80},(_,i)=>`${70+i*12},${245+Math.sin(i*.42)*amplitude}`).join(" ");
    return <><polyline points={points} {...commonStroke}/><DirectedEdge x1={90} y1={390} x2={990} y2={390} progress={progress} state={state}/><Label text={labels[0]||keyText} x={540} y={445} active state={state}/></>;
  }
  if (primitive === "horizon") {
    const eid = identityKeys[0] || labels[0] || "boundary";
    return <><circle cx="540" cy="245" r={70+progress*130} {...commonStroke}/><EntityMark id={eid} label={labelOf(eid)} icon={entityIcons?.[eid]} x={540} y={245} size={30}/><path d="M90 245 H990" {...commonStroke} opacity=".55"/><Label text={after||labels[0]} x={540} y={445} active state={state}/></>;
  }
  if (primitive === "spectrum") {
    const comparing = operation === "scale-compare";
    const leftWidth = comparing ? 310 - progress * 105 : 900;
    const rightWidth = comparing ? 310 + progress * 105 : 0;
    return <><defs><linearGradient id="motion-spectrum"><stop stopColor="#7447FF"/><stop offset=".35" stopColor="#3C8DFF"/><stop offset=".65" stopColor="#E9E45D"/><stop offset="1" stopColor="#E84E4E"/></linearGradient></defs>
      <rect x={comparing ? 120 : 90} y={comparing ? 135 : 185} width={leftWidth} height="100" rx="50" fill="url(#motion-spectrum)" opacity=".9"/>
      {comparing ? <rect x="620" y="285" width={rightWidth} height="100" rx="50" fill="url(#motion-spectrum)" opacity=".9"/> : <line x1={90+progress*900} y1="145" x2={90+progress*900} y2="335" stroke={PAPER} strokeWidth="9"/>}
      <Label text={before||labels[0]} x={comparing ? 280 : 210} y={comparing ? 285 : 390} state={state}/><Label text={after||labels[1]} x={comparing ? 790 : 870} y={comparing ? 435 : 390} active state={state}/></>;
  }
  if (primitive === "path") {
    const curve: [Point, Point, Point, Point] = [[95,390],[250,55],[720,55],[985,330]];
    const marker = cubicPoint(curve[0], curve[1], curve[2], curve[3], progress);
    const d = `M${curve[0][0]} ${curve[0][1]} C${curve[1][0]} ${curve[1][1]} ${curve[2][0]} ${curve[2][1]} ${curve[3][0]} ${curve[3][1]}`;
    const pathEid = identityKeys[0] || labels[0] || "traveler";
    // Waypoints, not just a traveller. A journey's authored entities are the
    // places it passes through; drawing only the first one left three
    // consecutive path scenes as the same dot on the same squiggle.
    if (entityCount >= 2) {
      const stops = Array.from({ length: entityCount }, (_, i) => {
        const t = entityCount === 1 ? 0 : i / (entityCount - 1);
        return { at: cubicPoint(curve[0], curve[1], curve[2], curve[3], t), reached: progress >= t - 0.04, ...entity(i) };
      });
      return <>
        <path d={d} {...commonStroke} opacity=".45"/>
        <path d={d} {...commonStroke} pathLength="1" strokeDasharray="1" strokeDashoffset={1-progress}/>
        {stops.map((stop, i) => (
          <g key={i} opacity={stop.reached ? 1 : 0.35}>
            <EntityMark id={stop.id} label={stop.label} icon={stop.icon} x={stop.at[0]} y={stop.at[1]} size={34} active={stop.reached} />
            {/* Captions alternate above/below the curve so a stop near the
                arc's peak does not sit on top of the stroke. */}
            <Label text={stop.icon ? stop.label : ""} x={Math.min(940, Math.max(140, stop.at[0]))} y={stop.at[1] + (i % 2 === 0 ? 66 : -62)}
              active={stop.reached} state={state} maxWidth={250} />
          </g>
        ))}
        {/* The traveller stays: it is what makes this a journey rather than a
            static list of stops. */}
        <circle cx={marker[0]} cy={marker[1]} r={13} fill={ACCENT} opacity={0.85} />
      </>;
    }
    return <><path d={d} {...commonStroke} opacity=".45"/>
      <path d={d} {...commonStroke} pathLength="1" strokeDasharray="1" strokeDashoffset={1-progress}/>
      <EntityMark id={pathEid} label={labels[0]} icon={entityIcons?.[pathEid]} x={marker[0]} y={marker[1]} size={22}/><Label text={keyText||labels[0]} x={540} y={455} active state={state}/></>;
  }
  if (primitive === "shells") {
    const centers=Array.from({length:4},(_,i)=>operatePoint([540,245],i,4,operation,progress));
    const coreEid = identityKeys[0] || labels[0] || "core";
    if (entityCount >= 2) {
      // One shell per authored layer, captioned on its own right edge.
      // nested-context uses squares captioned on top; keeping shells on
      // circles captioned to the side stops two different primitives from
      // resolving to the same picture.
      const core = entity(0);
      const shells = entityCount - 1;
      return <>
        {Array.from({ length: shells }, (_, i) => {
          const radius = (92 + i * 74) * (0.4 + progress * 0.6);
          const layer = entity(i + 1);
          return <React.Fragment key={i}>
            <circle cx={540} cy={245} r={radius} fill="none" stroke={i === shells - 1 ? colors.line : colors.muted}
              strokeWidth={i === shells - 1 ? 7 : 4} strokeDasharray={state === "hypothesis" ? "15 12" : undefined}
              opacity={0.4 + progress * 0.6} />
            <Label text={layer.label} x={Math.min(900, 540 + radius + 92)} y={245 - i * 62} active={i === shells - 1} state={state} maxWidth={230} />
          </React.Fragment>;
        })}
        <EntityMark id={core.id} label={core.label} icon={core.icon} x={540} y={245} size={44 + living * 3} />
        <Label text={core.icon ? core.label : ""} x={540} y={455} active state={state} maxWidth={300} />
      </>;
    }
    return <>{centers.map(([x,y],i)=><circle key={i} cx={x} cy={y} r={65+i*58*progress} {...commonStroke} opacity={.35+i*.15}/>)}
      <EntityMark id={coreEid} label={labels[0]} icon={entityIcons?.[coreEid]} x={centers[0]![0]} y={centers[0]![1]} size={32}/><Label text={labels[0]||keyText} x={540} y={455} active state={state}/></>;
  }
  if (primitive === "objects") {
    const entities = labels.slice(0,4);
    return <>{entities.map((label,i)=>{const total=Math.max(1,entities.length);const [x,y]=operatePoint([190+(i%2)*700,145+Math.floor(i/2)*210],i,total,operation,progress);const activated=operation!=="counter"||i<Math.ceil(total*progress);const eid=identityKeys[i]||label;return <g key={`${label}-${i}`} opacity={activated?1:.16}><EntityMark id={eid} label={labelOf(eid)} icon={entityIcons?.[eid]} x={x} y={y-22} size={46 + living * 2} active={activated}/>{i<2 ? <Label text={label} x={x} y={y+70} active={activated&&i===Math.floor(progress*total)} state={state} maxWidth={340}/> : null}</g>})}</>;
  }
  if (primitive === "network") {
    // The authored path. Before model_relations existed this branch drew a
    // FIXED seven-node, ten-link graph for every episode: three of those
    // nodes were always unlabeled filler (a scene may author at most four
    // entities), and none of the ten links corresponded to anything the
    // narration claimed. The labels and icons on top were topic-specific;
    // the structure underneath never was, which is the single biggest
    // reason these diagrams read as decoration beside the dialogue.
    if (relations.length > 0 && labels.length >= 2) {
      return <RelationGraph labels={labels} identityKeys={identityKeys} entityIcons={entityIcons}
        relations={relations} state={state} progress={progress} living={living} pop={pop} />;
    }
    // Fallback: a plan with no authored relations (or fewer than two
    // entities to connect) still renders exactly as it did before 1.5.0
    // rather than degrading to a blank frame.
    const bases: Point[]=[[160,125],[390,80],[700,105],[925,210],[780,400],[470,385],[150,325]];
    const nodes = bases.map((point, i) => operatePoint(point, i, bases.length, operation, progress));
    const links: Array<[number,number]>=[[0,1],[1,2],[2,3],[3,4],[4,5],[5,6],[6,0],[1,5],[2,4],[0,5]];
    return <>{links.map(([a,b],i)=><DirectedEdge key={i} x1={nodes[a]![0]} y1={nodes[a]![1]} x2={nodes[b]![0]} y2={nodes[b]![1]} progress={Math.max(0,progress-i*.045)} state={state}/>)}
      {nodes.map(([x,y],i)=>{const eid=identityKeys[i] || labels[i] || `entity-${i}`;return <EntityMark key={i} id={eid} icon={entityIcons?.[eid]} x={x} y={y} size={18+pop(i*.04)*9}/>})}</>;
  }
  if (primitive === "hierarchy") {
    const childBases: Point[]=[[210,380],[430,380],[650,380],[870,380]];
    const children=childBases.map((point,i)=>operatePoint(point,i,childBases.length,operation,progress));
    return <><Label text={labels[0]||"Root"} x={540} y={85} active state={state}/>
      <DirectedEdge x1={540} y1={120} x2={330} y2={230} progress={progress} state={state}/><DirectedEdge x1={540} y1={120} x2={750} y2={230} progress={progress} state={state}/>
      {/* The two branch-joint Dots stay plain: they are structural (mid-tree
          fan-out points), not authored entities, so there is nothing for
          Iconify to look up for them. The 4 leaves below ARE the scene's
          model_elements and get real icons. */}
      <Dot x={330} y={245} r={34} fill={BLUE}/><Dot x={750} y={245} r={34} fill={BLUE}/>
      {children.map(([x,y],i)=>{const eid=identityKeys[i]||labels[i]||`branch-${i}`;return <React.Fragment key={i}><RelationEdge x1={i<2?330:750} y1={270} x2={x} y2={y-25} progress={Math.max(0,progress-.18)} state={state} kind={kindBetween(0,i)} phase={living}/><EntityMark id={eid} label={labelOf(eid)} icon={entityIcons?.[eid]} x={x} y={y} size={25}/></React.Fragment>})}</>;
  }
  if (primitive === "one-to-many") {
    const targets: Array<[number,number]>=[[850,85],[920,180],[940,300],[860,410]];
    return <><Label text={labels[0]||before} x={220} y={245} active state={state}/>{targets.map((base,i)=>{const [x,y]=operatePoint(base,i,targets.length,operation,progress);const eid=identityKeys[i]||labels[i]||`branch-${i}`;return <React.Fragment key={i}><RelationEdge x1={352} y1={245} x2={x-30} y2={y} progress={Math.max(0,progress-i*.08)} state={state} kind={kindBetween(0,i)} phase={living}/><EntityMark id={eid} label={labelOf(eid)} icon={entityIcons?.[eid]} x={x} y={y} size={24}/></React.Fragment>})}</>;
  }
  if (primitive === "many-to-one") {
    // Redesigned from 4 static dots with straight lines to one point -- that
    // read as "dots, but labeled" rather than actually depicting convergence.
    // This draws a real funnel silhouette with a collecting vessel whose
    // fill level visibly rises as each source arrives and is absorbed
    // (fades out at the mouth, rather than persisting as a dot forever),
    // so the composition itself tells the "many things become one" story
    // instead of relying entirely on the label to say so.
    const sources: Array<[number,number]>=[[150,85],[90,180],[80,300],[160,410]];
    const mouthX = 430, mouthTop = 95, mouthBottom = 395, spoutX = 610, spoutY = 245;
    const vesselX = 760, vesselY = 245, vesselW = 190, vesselH = 150;
    return <>
      <path d={`M${mouthX} ${mouthTop} L${spoutX} ${spoutY-16} L${spoutX} ${spoutY+16} L${mouthX} ${mouthBottom} Z`} fill={colors.fill} stroke={colors.line} strokeWidth="6" opacity=".5"/>
      <rect x={vesselX-vesselW/2} y={vesselY-vesselH/2} width={vesselW} height={vesselH} rx="20" fill="none" stroke={colors.line} strokeWidth="7"/>
      {/* The rising fill is the payoff of this whole primitive -- it must
          read as a solid, obviously-filling volume against the dark field,
          not a low-opacity tint of the same stroke colour as the vessel
          outline (which a live render showed disappearing entirely). */}
      <rect x={vesselX-vesselW/2+7} y={vesselY+vesselH/2-7-(vesselH-14)*progress} width={vesselW-14} height={Math.max(0,(vesselH-14)*progress)} rx="10" fill={ACCENT} opacity=".92"/>
      {sources.map((base,i)=>{
        // Each source travels toward the funnel mouth on its own delayed
        // schedule, then is absorbed (fades rather than parking at the
        // mouth forever) -- 4 distinct arrival beats instead of one static
        // frame, matching "consequence, then a living hold" for a
        // convergence rather than a single snapshot of it.
        // Travel all the way to the spout (converging on the funnel's exit),
        // not to a holding position outside the mouth -- a live render showed
        // sources bunching up at the entrance instead of visibly passing
        // through, which reads as "queued", the opposite of "converged".
        const arrival = Math.max(0, Math.min(1, progress * 1.35 - i * 0.14));
        const x = base[0] + (spoutX - base[0]) * arrival;
        const y = base[1] + (spoutY - base[1]) * arrival;
        // Fade only in the final stretch, once inside the funnel body.
        const absorbed = arrival > 0.82;
        const eid = identityKeys[i] || labels[i] || `source-${i}`;
        return <g key={i} opacity={absorbed ? Math.max(0, 1 - (arrival - 0.82) * 6) : 1}>
          {arrival < 0.5 && <DirectedEdge x1={x + 26} y1={y} x2={Math.min(mouthX - 12, x + 96)} y2={y} progress={Math.min(1, arrival * 2.4)} state={state} />}
          <EntityMark id={eid} label={labelOf(eid)} icon={entityIcons?.[eid]} x={x} y={y} size={22} />
        </g>;
      })}
      {/* Clear of the vessel's bottom edge -- at +45 the 2-line label box
          overlapped the vessel itself on a live render. */}
      <Label text={after || labels[0]} x={vesselX} y={vesselY + vesselH / 2 + 78} active state={state} maxWidth={340} />
    </>;
  }
  if (primitive === "facets-around-center") {
    if (entityCount >= 2) {
      // The facets are the authored entities, not six decorative diamonds
      // around a captioned circle. Six anonymous facets said nothing about
      // which viewpoints the narration was actually listing.
      const slots: Point[] = [[540, 78], [846, 168], [846, 336], [540, 424], [234, 336], [234, 168]];
      const centre = entity(0);
      const facetIndices = Array.from({ length: entityCount - 1 }, (_, i) => i + 1);
      // Spread the used facets evenly around the ring instead of clustering
      // them at the top, so two facets do not read as a lopsided pair.
      const step = Math.max(1, Math.floor(slots.length / facetIndices.length));
      return <>
        {facetIndices.map((entityIndex, i) => {
          const [x, y] = slots[(i * step) % slots.length]!;
          const facet = entity(entityIndex);
          return <React.Fragment key={entityIndex}>
            <RelationEdge x1={540} y1={245} x2={x} y2={y}
              progress={Math.max(0, Math.min(1, progress * 1.3 - i * 0.1))} state={state}
              kind={kindBetween(0, entityIndex)} phase={living} />
            <EntityMark id={facet.id} label={facet.label} icon={facet.icon} x={x} y={y} size={36} />
            <Label text={facet.icon ? facet.label : ""} x={Math.min(900, Math.max(180, x))} y={y + (y > 245 ? 64 : -58)}
              active={i === 0} state={state} maxWidth={230} />
          </React.Fragment>;
        })}
        <circle cx={540} cy={245} r={84} fill={colors.fill} stroke={colors.line} strokeWidth="8" />
        <EntityMark id={centre.id} label={centre.label} icon={centre.icon} x={540} y={245} size={52 + living * 3} />
        <Label text={centre.icon ? centre.label : ""} x={540} y={245 + 118} active state={state} maxWidth={280} />
      </>;
    }
    const facets: Array<[number,number]>=[[540,65],[820,150],[820,350],[540,430],[260,350],[260,150]];
    return <>{facets.map((base,i)=>{const [x,y]=operatePoint(base,i,facets.length,operation,progress);return <React.Fragment key={i}><path d={`M540 245 L${x} ${y}`} {...commonStroke} opacity={.4+progress*.5}/><polygon points={`${x},${y-30} ${x+34},${y} ${x},${y+30} ${x-34},${y}`} fill={i%2?BLUE:ACCENT} opacity={.68+progress*.32}/></React.Fragment>})}
      <circle cx="540" cy="245" r="84" fill={colors.fill} stroke={colors.line} strokeWidth="8"/><Label text={labels[0]||keyText} x={540} y={245} active state={state}/></>;
  }
  if (primitive === "overlapping-sets") {
    const spread=105*(1-progress);
    const compare=operation==="scale-compare"?progress:0;
    return <><circle cx={430-spread} cy="245" r={180-compare*55} fill="#65C7F733" stroke={BLUE} strokeWidth="7"/><circle cx={650+spread} cy="245" r={180+compare*45} fill="#FFD16633" stroke={ACCENT} strokeWidth="7"/>
      <EntityMark id={entity(0).id} label={entity(0).label} icon={entity(0).icon} x={352-spread} y={245} size={40}/>
      <EntityMark id={entity(1).id} label={entity(1).label} icon={entity(1).icon} x={728+spread} y={245} size={40}/>
      <Label text={labels[0]} x={252-spread} y={368} state={state} maxWidth={250}/><Label text={labels[1]} x={828+spread} y={368} state={state} maxWidth={250}/>
      {/* The third authored entity is what the two sets SHARE -- the whole
          reason to draw an intersection. It was previously dropped, leaving
          the overlap an unexplained lens. */}
      {entityCount >= 3 ? <Label text={entity(2).label} x={540} y={245} active state={state} maxWidth={210}/> : null}</>;
  }
  if (primitive === "nested-context") {
    // The layers ARE the authored entities: entity 0 is the item, and each
    // later entity is the wider context it sits inside. Previously this drew
    // four fixed rectangles and captioned only the first entity, so a scene
    // that authored "vacuum gap / conduction / heat loss" rendered as boxes
    // labelled "vacuum gap" -- and every other nested-context scene in the
    // episode rendered as exactly the same picture.
    if (entityCount >= 2) {
      // Nesting order comes from the `contains` relations, not from the order
      // the entities happen to be listed in.
      //
      // A real episode authored "thermos CONTAINS vacuum gap" and this drew
      // the thermos as the innermost core inside the vacuum gap -- the
      // containment stated backwards, which is exactly the class of error
      // this primitive exists to avoid. depth[] walks the contains edges so a
      // container always encloses what it contains.
      const depth = new Array(entityCount).fill(0);
      for (let pass = 0; pass < entityCount; pass++) {
        for (const relation of relations) {
          if (relation.kind !== "contains") continue;
          if (relation.from >= entityCount || relation.to >= entityCount) continue;
          depth[relation.to] = Math.max(depth[relation.to]!, depth[relation.from]! + 1);
        }
      }
      // Only entities actually joined by containment get drawn as layers. An
      // entity the plan never nested is not a layer of anything, and drawing
      // it as one invents a claim -- it is parked outside the outermost ring
      // instead, present but visibly not part of the nesting.
      const nestedIn = new Set<number>();
      for (const relation of relations) {
        if (relation.kind !== "contains") continue;
        if (relation.from < entityCount) nestedIn.add(relation.from);
        if (relation.to < entityCount) nestedIn.add(relation.to);
      }
      const chain = Array.from({ length: entityCount }, (_, i) => i)
        .filter((i) => nestedIn.size === 0 || nestedIn.has(i))
        .sort((a, b) => depth[a]! - depth[b]!);
      const outside = Array.from({ length: entityCount }, (_, i) => i).filter((i) => !chain.includes(i));
      const rings = Math.max(0, chain.length - 1);
      const coreIndex = chain[chain.length - 1] ?? 0;
      const core = entity(coreIndex);
      const sizeFor = (ring: number) => 440 - ring * 150;
      return <>
        {Array.from({ length: rings }, (_, ring) => {
          const size = sizeFor(ring) * (0.35 + progress * 0.65);
          const layer = entity(chain[ring]!);
          return <React.Fragment key={ring}>
            <rect x={540 - size / 2} y={245 - size / 2} width={size} height={size} rx={34}
              fill={ring === rings - 1 ? colors.fill : "none"} stroke={ring === 0 ? colors.line : colors.muted}
              strokeWidth={ring === 0 ? 8 : 4} opacity={0.45 + progress * 0.55} />
            <Label text={layer.label} x={540} y={245 - size / 2 + 32} active={ring === 0} state={state} maxWidth={360} />
          </React.Fragment>;
        })}
        <EntityMark id={core.id} label={core.label} icon={core.icon} x={540} y={245} size={48 + living * 3} />
        <Label text={core.icon ? core.label : ""} x={540} y={245 + 74} active state={state} maxWidth={300} />
        {outside.map((index, i) => {
          const stray = entity(index);
          const x = 150;
          const y = 120 + i * 130;
          return <React.Fragment key={`out-${index}`}>
            <EntityMark id={stray.id} label={stray.label} icon={stray.icon} x={x} y={y} size={30} active={false} />
            <Label text={stray.icon ? stray.label : ""} x={x} y={y + 58} state={state} maxWidth={230} />
          </React.Fragment>;
        })}
      </>;
    }
    const sizes=[360,280,200,120];
    const centers=sizes.map((_,i)=>operatePoint([540,245],i,sizes.length,operation,progress));
    return <>{sizes.map((size,i)=>{const [x,y]=centers[i]!;return <rect key={i} x={x-size*progress/2} y={y-size*progress/2} width={size*progress} height={size*progress} rx={30+i*5} fill={i===3?colors.fill:"none"} stroke={i===0?colors.line:colors.muted} strokeWidth={i===0?8:4}/>})}
      <Label text={labels[0]||keyText} x={540} y={245} active state={state}/></>;
  }
  if (primitive === "cycle") {
    const pts: Array<[number,number]>=[[540,70],[850,245],[540,420],[230,245]];
    const moved=pts.map((point,i)=>operatePoint(point,i,pts.length,operation,progress));
    if (entityCount >= 2) {
      // A loop of the scene's OWN entities. The plain Dots gave every cycle
      // scene the same four anonymous blobs regardless of subject.
      const ring: Point[] = entityCount === 2
        ? [[300, 245], [780, 245]]
        : [[540, 92], [830, 245], [540, 398], [250, 245]];
      const nodes = ring.slice(0, entityCount);
      return <>
        {nodes.map(([x, y], i) => {
          const next = nodes[(i + 1) % nodes.length]!;
          return <RelationEdge key={`e${i}`} x1={x} y1={y} x2={next[0]} y2={next[1]}
            progress={Math.max(0, progress - i * 0.12)} state={state}
            kind={kindBetween(i, (i + 1) % nodes.length)} phase={living} />;
        })}
        {nodes.map(([x, y], i) => {
          const node = entity(i);
          return <React.Fragment key={`n${i}`}>
            <EntityMark id={node.id} label={node.label} icon={node.icon} x={x} y={y} size={38} />
            <Label text={node.icon ? node.label : ""} x={x} y={y + (y > 245 ? 66 : -60)} active={i === 0} state={state} maxWidth={240} />
          </React.Fragment>;
        })}
      </>;
    }
    return <>{moved.map(([x,y],i)=>{const next=moved[(i+1)%moved.length]!;return <React.Fragment key={i}><DirectedEdge x1={x} y1={y} x2={next[0]} y2={next[1]} progress={Math.max(0,progress-i*.12)} state={state} curved/><Dot x={x} y={y} r={31} fill={i%2?BLUE:ACCENT}/></React.Fragment>})}<Label text={keyText||labels[0]} x={540} y={245} active state={state}/></>;
  }
  if (primitive === "cause-chain") {
    const bases: Point[]=[[120,245],[385,245],[650,245],[920,245]];
    const points=bases.map((point,i)=>operatePoint(point,i,bases.length,operation,progress));
    // denseLabelSlot places up to 4 entities on distinct, non-overlapping
    // positions (2x2), so there is no spatial reason to label only the first
    // two of up to four accepted entities -- that left the back half of the
    // chain, where the consequence and resolution actually sit, unlabeled.
    return <>{points.map(([x,y],i)=>{const next=points[i+1];const eid=identityKeys[i]||labels[i]||`step-${i}`;return <React.Fragment key={i}>{next&&<RelationEdge x1={x+40} y1={y} x2={next[0]-40} y2={next[1]} progress={Math.max(0,progress-i*.16)} state={state} kind={kindBetween(i,i+1)} phase={living}/>}<EntityMark id={eid} label={labelOf(eid)} icon={entityIcons?.[eid]} x={x} y={y} size={30+pop(i*.12)*10}/><Label text={labels[i]} {...denseLabelSlot(i)} active={i===Math.min(MAX_LABELS-1,Math.floor(progress*4))} state={state} maxWidth={260}/></React.Fragment>})}</>;
  }
  if (primitive === "before-after") {
    const leftWidth=390*(operation==="scale-compare"?1-progress*.28:1);
    const rightWidth=390*(operation==="scale-compare"?1+progress*.28:1);
    const inward=operation==="compress"?progress*105:0;
    const leftX=90+inward+leftWidth/2, rightX=990-inward-rightWidth/2;
    // Before/after is a state change of usually one entity (occasionally two
    // being compared) -- the right icon falls back to identityKeys[0] rather
    // than going empty, so a single-entity scene still gets its icon on both
    // sides instead of only the left box.
    const leftIcon=identityKeys[0]?entityIcons?.[identityKeys[0]]:undefined;
    const rightId=identityKeys[1]||identityKeys[0];
    const rightIcon=rightId?entityIcons?.[rightId]:undefined;
    return <><rect x={90+inward} y="100" width={leftWidth} height="290" rx="34" fill={colors.fill} stroke={colors.muted} strokeWidth="6"/><rect x={990-inward-rightWidth} y="100" width={rightWidth} height="290" rx="34" fill={colors.fill} stroke={colors.line} strokeWidth="8" opacity={.3+progress*.7}/>
      {/* Two plain colour-filled boxes with only a text label read as inert
          placeholders, not an illustration of anything -- real watch feedback
          on run_ad5bd430 called this exact primitive out by name ("the boxes
          were stupid and not matching"). EntityMark (with its real Iconify
          icon when one resolved, falling back to its hash shape otherwise)
          gives each box an actual picture instead of being colour + text
          only, the same identity contract every other EntityMark call site
          already uses. */}
      {identityKeys[0] && <EntityMark id={identityKeys[0]} label={labels[0]} icon={leftIcon} x={leftX} y={160} size={36}/>}
      {rightId && <EntityMark id={rightId} label={labelOf(rightId)} icon={rightIcon} x={rightX} y={160} size={36}/>}
      {/* Both Labels used to fall back to the default maxWidth (300).
          Label's own char-budget formula is `max(10, floor((maxWidth-38)/30.24))`
          -- the `max(10, ...)` floor means anything under ~340 collapses to
          the SAME 10-char budget as the default, so tying maxWidth to
          leftWidth/rightWidth (~280-499px) was a no-op fix the first time:
          "Compact liquid arrangement" and "Open solid arrangement" still
          truncated to "Compact liquid ar..." / "Open solid arrangeme..." on a
          real ice-float render (run_f7167c64). Raised again after
          run_ad5bd430 showed even longer, semicolon-joined compound clauses
          ("Whole onion beside Buddy; ...") still truncating at 500. The Label
          pill sizes its own background independently of the box drawn beside
          it, so this does not have to track leftWidth/rightWidth -- pushing
          it further trades more headroom past the box's drawn edge for
          fewer truncated real sentences.

          NOT fully solved even at 560 (maxChars=17): a real test with
          "Whole onion sits beside Buddy waiting" (38 chars, representative
          of production's semicolon-joined state_before/state_after clauses)
          still truncates its second line. Pushing maxWidth further starts
          risking the pill visibly overflowing the 1080-wide canvas on both
          sides at once. The remaining gap is better closed by constraining
          how long state_before/state_after are AUTHORED (prompt/schema
          level) than by continuing to inflate this box -- genuinely long
          content still degrades gracefully to Label's own ellipsis overflow
          rather than crashing, disappearing, or silently dropping words. */}
      <Label text={before||labels[0]} x={leftX} y={325} state={state} maxWidth={560}/><DirectedEdge x1={490} y1={245} x2={585} y2={245} progress={progress} state={state}/><Label text={after||labels[1]} x={rightX} y={325} active state={state} maxWidth={560}/></>;
  }
  if (primitive === "map") {
    const places: Array<[number,number]>=[[130,360],[315,135],[520,305],[735,110],[950,340]];
    return <><path d="M70 410 Q210 40 385 250 T690 210 T1010 355" fill="none" stroke={colors.muted} strokeWidth="30" opacity=".4"/>
      {places.map((base,i)=>{const moved=places.map((point,j)=>operatePoint(point,j,places.length,operation,progress));const [x,y]=moved[i]!;return <React.Fragment key={i}>{i<moved.length-1&&<DirectedEdge x1={x} y1={y} x2={moved[i+1]![0]} y2={moved[i+1]![1]} progress={Math.max(0,progress-i*.13)} state={state}/>}<g transform={`translate(${x} ${y}) scale(.55)`}><path d="M0 0 c-20-30-45-5-45 17 0 33 45 68 45 68s45-35 45-68c0-22-25-47-45-17z" fill={i===places.length-1?GREEN:ACCENT}/></g></React.Fragment>})}</>;
  }
  if (primitive === "timeline") {
    const bases: Point[]=[[130,245],[350,245],[570,245],[790,245],[970,245]];
    const points=bases.map((point,i)=>operatePoint(point,i,bases.length,operation,progress));
    // Same reasoning as cause-chain: up to 4 labelled entities all have a
    // distinct, collision-free denseLabelSlot, so the back half of the
    // timeline was withheld from viewers for no spatial reason.
    return <><path d={`M${points.map(([x,y])=>`${x} ${y}`).join(" L")}`} {...commonStroke} opacity=".5"/>{points.map(([x,y],i)=>{const eid=identityKeys[i]||labels[i]||`moment-${i}`;return <React.Fragment key={i}><line x1={x} y1={y-50} x2={x} y2={y+50} stroke={i/4<=progress?colors.line:colors.muted} strokeWidth="8"/><EntityMark id={eid} label={labelOf(eid)} icon={entityIcons?.[eid]} x={x} y={y} size={i/4<=progress?24:12} active={i/4<=progress}/><Label text={labels[i]} {...denseLabelSlot(i)} active={i===Math.min(MAX_LABELS-1,Math.floor(progress*5))} state={state} maxWidth={260}/></React.Fragment>})}</>;
  }
  if (primitive === "quantity") {
    if (numericValue === null) throw new Error("quantity primitive requires an explicit numericValue");
    const target = numericValue;
    const dots = Math.max(5, Math.min(60, Math.round(target)));
    const active = Math.round(dots*progress);
    // Same reasoning as particles: a count is a count of some ONE thing
    // ("stars", "votes", "cells") -- one representative icon repeated, not
    // 60 different icons, and not 60 flat-colour dots either.
    const repId = identityKeys[0] || labels[0] || "unit";
    const repIcon = entityIcons?.[repId];
    return <>{Array.from({length:dots},(_,i)=>{const [x,y]=operatePoint([120+(i%10)*92,90+Math.floor(i/10)*65],i,dots,operation,progress);return <g key={i} opacity={i<active?1:.25}><EntityMark id={repId} label={labels[0]} icon={repIcon} x={x} y={y} size={i<active?22:11}/></g>})}
      <text x="540" y="430" textAnchor="middle" fill={PAPER} fontSize="92" fontWeight="900">{Math.round(target*progress).toLocaleString()}</text></>;
  }
  if (primitive === "physical-transformation") {
    // Had no branch of its own, so it fell through to the generic default
    // below and drew the same rotating slab as any unhandled primitive -- two
    // different authored primitives rendering as one picture.
    //
    // Deliberately not before-after: that primitive cuts between two finished
    // panels, this one keeps a single body of matter on screen and reorganises
    // it in place, so the viewer watches the conversion rather than comparing
    // two end states.
    const grains = 27;
    const provisional = state === "hypothesis";
    const broken = state === "contradiction";
    return <><rect x="150" y="104" width="780" height="248" rx={26 + progress * 96} fill={colors.fill} stroke={colors.line} strokeWidth="7" opacity={.42 + progress * .38} />
      {Array.from({ length: grains }, (_, i) => {
        const lattice: Point = [236 + (i % 9) * 68, 160 + Math.floor(i / 9) * 62];
        // The loosening is the point: grains leave their lattice site as the
        // conversion proceeds, then the operation places them.
        const loosened: Point = [lattice[0] + Math.sin(i * 1.7) * 52 * progress, lattice[1] + Math.cos(i * 2.3) * 44 * progress];
        const [ox, oy] = operatePoint(loosened, i, grains, operation, progress);
        const x = ox + (broken ? Math.sin(i * 2.6) * 30 * progress : 0);
        const y = oy + (broken ? Math.cos(i * 1.9) * 24 * progress : 0);
        const radius = 14 - progress * 5;
        const opacity = .4 + pop(i * .018) * .6;
        const fill = i % 4 === 0 ? ACCENT : colors.line;
        if (provisional) return <circle key={i} cx={x} cy={y} r={radius} fill="none" stroke={fill} strokeWidth="3" strokeDasharray="6 6" opacity={opacity} />;
        return <Dot key={i} x={x} y={y} r={radius} fill={fill} opacity={opacity} />;
      })}
      <Label text={before || labels[0]} x={260} y={430} state={state} />
      <DirectedEdge x1={440} y1={430} x2={640} y2={430} progress={progress} state={state} />
      <Label text={after || labels[1] || keyText} x={820} y={430} active state={state} /></>;
  }
  const physicalScale=operation==="scale-compare"?0.72+progress*.55:operation==="compress"?1-progress*.42:1;
  return <><g transform={`translate(540 245) rotate(${progress*180}) scale(${physicalScale})`}><rect x="-170" y="-100" width="340" height="200" rx={20+progress*50} fill={colors.fill} stroke={colors.line} strokeWidth="8"/><circle r={progress*90} fill={GREEN} opacity={progress*.55}/></g>
    <Label text={before||labels[0]} x={260} y={430} state={state}/><Label text={after||labels[1]||keyText} x={820} y={430} active state={state}/></>;
}

function OperationStage({ operation, progress, living, state, numericValue, children }: { operation: VisualOperation; progress: number; living: number; state: VisualState; numericValue: number | null; children: React.ReactNode }) {
  const colors = palette[state];
  const transform = operation === "compress"
    ? `translate(540 245) scale(${1-progress*.18} ${1-progress*.08}) translate(-540 -245)`
    : operation === "group"
      ? `translate(540 245) scale(${.84+progress*.16}) translate(-540 -245)`
      : operation === "sort"
        ? `translate(540 245) rotate(${(1-progress)*-4}) translate(-540 -245)`
        : operation === "scale-compare"
          ? `translate(540 245) scale(${.9+progress*.1}) translate(-540 -245)`
          : operation === "payoff"
            ? `translate(540 245) scale(${.92+progress*.08}) translate(-540 -245)`
            : `translate(0 ${operation==="stack"?(1-progress)*54:0})`;
  // .62 floor, not .35: this wraps every scene's entire geometry, so the old
  // floor meant every scene opened at 35% opacity against a near-black
  // background until the transform ramped up -- watch feedback specifically
  // called out the opening's model as "almost invisible", and the first
  // frames of every other scene had the same problem, just less noticed
  // since the opening is what a viewer judges first.
  return <g transform={`${transform} translate(0 ${living * 2 - 1})`} opacity={.62+progress*.38}>
    {operation === "timeline" ? <g clipPath="url(#operation-reveal)">{children}</g> : children}
    {operation === "counter" && numericValue !== null && <text x="1000" y="92" textAnchor="end" fill={colors.line} fontSize="64" fontWeight="900">{Math.round(numericValue*progress).toLocaleString()}</text>}
    {operation === "compress" && <><path d={`M${80+progress*165} 170 v150`} stroke={colors.line} strokeWidth="10"/><path d={`M${1000-progress*165} 170 v150`} stroke={colors.line} strokeWidth="10"/></>}
    {operation === "scale-compare" && <><line x1="140" y1="440" x2={140+progress*300} y2="440" stroke={ACCENT} strokeWidth="12"/><line x1="620" y1="440" x2={620+progress*380} y2="440" stroke={GREEN} strokeWidth="12"/></>}
    {operation === "payoff" && <circle cx="540" cy="245" r={170+progress*80} fill="none" stroke={GREEN} strokeWidth="8" opacity={.15+progress*.5}/>}
  </g>;
}

function StateDecorator({ state, consequence }: { state: VisualState; consequence: number }) {
  if (state === "hypothesis") return <g opacity={.25+consequence*.75}><rect x="48" y="48" width="984" height="414" rx="52" fill="none" stroke="#E8B96A" strokeWidth="5" strokeDasharray="16 14"/><circle cx="980" cy="80" r="34" fill="#3B2E22" stroke="#E8B96A" strokeWidth="5"/><text x="980" y="92" textAnchor="middle" fill={PAPER} fontSize="38" fontWeight="900">?</text></g>;
  // No contradiction overlay. This used to draw two red zigzags at fixed
  // coordinates in the middle of the canvas, on top of whatever the diagram
  // was -- a decorative "crack" that in practice landed across entity marks
  // and captions and read as a stray glyph nobody could interpret. The
  // contradiction state is already signalled where it belongs: the whole
  // palette turns red, provisional geometry is dashed, and Geometry
  // cross-fades the failing model into the corrected one. A slash drawn over
  // the content adds nothing those three do not already say.
  if (state === "contradiction") return null;
  if (state === "qualification") return <rect x="48" y="48" width="984" height="414" rx="52" fill="none" stroke="#B794F4" strokeWidth="6" strokeDasharray="18 14" opacity={.3+consequence*.65}/>;
  // No payoff ring here: ExplanationScene's own PayoffResolution overlay draws
  // the canonical unifying ring on top of everything. Both firing at once was
  // a literal duplicate circle competing with the payoff caption for
  // attention -- this is the model's copy of a decoration the composition
  // layer already owns.
  return null;
}

export function MotionDesignSystem({ primitive, operation = "timeline", state = "mechanism", numericValue = null, elements = [], entityIdentityKeys = [], entityIcons = {}, modelRelations = [], before = "", after = "", keyText = "", diagnosticMode = "normal" }: {
  primitive: VisualPrimitive; operation?: VisualOperation; state?: VisualState; numericValue?: number | null; elements?: string[]; entityIdentityKeys?: string[]; entityIcons?: EntityIconMap; modelRelations?: ModelRelation[]; before?: string; after?: string; keyText?: string;
  diagnosticMode?: "normal" | "foreground-only" | "background-only";
}) {
  const { setup, transform, consequence, hold, living, pop } = useProgress();
  if ((operation === "counter" || primitive === "quantity") && (numericValue === null || !Number.isFinite(numericValue))) {
    throw new Error(`${operation}/${primitive} requires an explicit numericValue`);
  }
  // Identity labels come only from model elements. Before/after remain owned
  // by comparison primitives instead of being appended as duplicate pills.
  // Capped at MAX_LABELS (one central, two supporting) regardless of
  // primitive: more than that reads as competing clutter rather than a
  // legible diagram, even when every label individually has its own slot.
  //
  // entityIdentityKeys (parallel to elements, by index) is a proxy identity
  // for the SAME entity across scenes even when its display wording changes
  // -- it seeds EntityMark's shape/colour hash instead of the raw label text,
  // so "the cell" and "this structure" (same underlying entity, different
  // words) render as the same mark rather than two unrelated ones. This does
  // not solve cross-scene identity in general (that needs an authored
  // canonical entity list the planner doesn't emit yet); it only keeps a
  // single scene's marks stable when the compiler already supplies keys.
  const visibleEntities = state === "payoff" ? [] : (() => {
    const seen = new Set<string>();
    const pairs: Array<{ label: string; identity: string }> = [];
    elements.forEach((el, i) => {
      if (!el || seen.has(el)) return;
      seen.add(el);
      pairs.push({ label: el, identity: entityIdentityKeys[i] || el.toLowerCase() });
    });
    // MULTI_ENTITY_PRIMITIVES draw one mark per authored entity rather than
    // a fixed pair, so capping them at 2 silently dropped half the scene's
    // model: a 4-source many-to-one funnel rendered only 2 sources, and the
    // dropped ones also lost their resolved icons (caught on a live render,
    // not from reading the code). MAX_LABELS still governs how many get
    // TEXT labels -- this cap is about how many marks exist at all.
    const multiEntity = MULTI_ENTITY_PRIMITIVES.has(primitive) || operation === "timeline";
    return pairs.slice(0, multiEntity ? 4 : 2);
  })();
  const labels = visibleEntities.map((e) => e.label);
  const identityKeys = visibleEntities.map((e) => e.identity);
  // modelRelations indexes `elements` as the COMPILER cleaned it, but
  // visibleEntities de-duplicates and re-caps that list (to 2 for
  // single-pair primitives, 4 otherwise) -- so a relation's index can point
  // at a different entity here than it did upstream, or at one that is no
  // longer drawn. Remap through the display list and drop the rest; an edge
  // pointing at the wrong mark states a claim the plan never made, which is
  // worse for the viewer than one fewer connection.
  const visibleRelations = (() => {
    const slotByLabel = new Map<string, number>();
    visibleEntities.forEach((entity, index) => slotByLabel.set(entity.label, index));
    const remapped: ModelRelation[] = [];
    for (const relation of modelRelations) {
      const fromLabel = elements[relation.from];
      const toLabel = elements[relation.to];
      if (fromLabel === undefined || toLabel === undefined) continue;
      const from = slotByLabel.get(fromLabel);
      const to = slotByLabel.get(toLabel);
      if (from === undefined || to === undefined || from === to) continue;
      remapped.push({ from, to, kind: relation.kind });
    }
    return remapped;
  })();
  // Several Geometry branches fall back to keyText/before/after when their
  // own labels array is empty (`labels[0] || keyText`, and similar) -- exactly
  // what payoff leaves empty. Left unguarded, the model kept drawing its own
  // copy of the same phrase PayoffResolution renders as the large closing
  // statement: the diagram and the overlay said the same thing twice, and the
  // diagram's copy sat underneath at low opacity as a ghost the audit
  // specifically called out ("underlying diagram text remains visible").
  const isPayoffState = state === "payoff";
  const geometryKeyText = isPayoffState ? "" : keyText;
  const geometryBefore = isPayoffState ? "" : before;
  const geometryAfter = isPayoffState ? "" : after;
  const colors = palette[state];
  const foregroundVisible = diagnosticMode !== "background-only";
  const backgroundVisible = diagnosticMode !== "foreground-only";
  return <div style={{ position:"relative", width:"100%", height:510, borderRadius:36, overflow:"hidden", boxShadow:diagnosticMode==="normal"?"0 24px 70px #0008":"none" }}>
    <svg viewBox="0 0 1080 510" style={{ width:"100%", height:"100%", display:"block" }}>
      <defs>
        <marker id="motion-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill={colors.line}/></marker>
        <clipPath id="operation-reveal"><rect x="0" y="0" width={1080*transform} height="510"/></clipPath>
      </defs>
      {backgroundVisible ? <rect x="12" y="12" width="1056" height="486" rx="34" fill={BG} stroke={colors.muted} strokeWidth="2" opacity="0.96" /> : null}
      {foregroundVisible ? <OperationStage operation={operation} progress={transform} living={living} state={state} numericValue={numericValue}>
        {state === "contradiction" ? <>
          <g opacity={1-consequence}><Geometry primitive={primitive} operation={operation} state="hypothesis" labels={labels} identityKeys={identityKeys} entityIcons={entityIcons} before={before} after={after} keyText={keyText} numericValue={numericValue} relations={visibleRelations} progress={transform} living={living} pop={pop}/></g>
          <g opacity={consequence}><Geometry primitive={primitive} operation={operation} state="contradiction" labels={labels} identityKeys={identityKeys} entityIcons={entityIcons} before={before} after={after} keyText={keyText} numericValue={numericValue} relations={visibleRelations} progress={transform} living={living} pop={pop}/></g>
        </> : <Geometry primitive={primitive} operation={operation} state={state} labels={labels} identityKeys={identityKeys} entityIcons={entityIcons} before={geometryBefore} after={geometryAfter} keyText={geometryKeyText} numericValue={numericValue} relations={visibleRelations} progress={transform} living={living} pop={pop}/>}
      </OperationStage> : null}
      {foregroundVisible ? <StateDecorator state={state} consequence={consequence}/> : null}
    </svg>
    {foregroundVisible&&state==="contradiction"&&consequence>0&&keyText&&<div style={{position:"absolute",left:150,right:150,bottom:20,textAlign:"center",fontSize:36,fontWeight:900,color:RED,opacity:Math.min(1,consequence+hold*.2),textShadow:"0 5px 20px #000"}}>{labelLines(keyText, 32).flat().slice(0,1)}</div>}
    <div data-motion-phase={hold>0?"hold":consequence>0?"consequence":transform>0?"transform":setup>0?"setup":"idle"} style={{display:"none"}}/>
  </div>;
}

export const RELATIONSHIP_PRIMITIVES: RelationshipPrimitive[] = [
  "network","hierarchy","one-to-many","many-to-one","facets-around-center",
  "overlapping-sets","nested-context","cycle","cause-chain","before-after",
  "map","timeline","quantity","spectrum","physical-transformation",
];

export const ALL_VISUAL_PRIMITIVES: VisualPrimitive[] = [
  "particles","rays","wave","horizon","spectrum","path","shells","objects",
  ...RELATIONSHIP_PRIMITIVES.filter((primitive) => primitive !== "spectrum"),
];
