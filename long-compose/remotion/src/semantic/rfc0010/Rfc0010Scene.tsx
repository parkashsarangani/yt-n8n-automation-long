/**
 * RFC 0010 explanatory graphics — draw the brief, not a decoration.
 *
 * These replace the generic `semanticRegistry` shapes for RFC 0010 beats. A
 * rendered benchmark scored the old path 0.05-0.28 semantic match with 0.60
 * generic filler across five beats, because `scale-comparison` drew the same
 * dot-grid box and empty box regardless of content: no axis, no unit, no
 * values, no labels, and byte-identical output for four consecutive beats
 * whose narration was "put the speeds on one scale", "walking covers 20 km in
 * four hours" and "a message covers it in a fraction of a second".
 *
 * The rule these components follow: every visible element comes from named
 * data. If the scene has an axis, it is drawn with its unit and maximum. If a
 * marker carries a value, the marker sits at that value. If it carries a rate
 * or an elapsed time, those are drawn as text beside it. Nothing is drawn
 * because a slot existed -- so a scene that is missing its data renders as
 * visibly missing rather than as plausible-looking geometry, and the engine's
 * pre-admission pixel QA can catch it.
 */
import {useCurrentFrame, useVideoConfig} from "remotion";

import {fitText} from "./text-fit";
import type {Rfc0010Axis, Rfc0010Marker, Rfc0010Node, Rfc0010Scene} from "./types";

// 1920x1080 viewBox so safe-area maths is in real output pixels.
export const W = 1920;
export const H = 1080;
export const SAFE_X = 150;
export const SAFE_TOP = 96;
export const SAFE_BOTTOM = 984;
export const SAFE_W = W - SAFE_X * 2;

const BG = "#08101E";
const PAPER = "#F7F4EA";
const MUTED = "#9FB2C9";
const ACCENT = "#FFD166";
const GREEN = "#7DE2A8";
const BLUE = "#65C7F7";
const TEAL = "#56D6C9";
const VIOLET = "#B79CFF";
const SERIES = [BLUE, GREEN, ACCENT, VIOLET, TEAL];

function progress(): number {
  const frame = useCurrentFrame();
  const {durationInFrames} = useVideoConfig();
  return Math.max(0, Math.min(1, frame / Math.max(1, durationInFrames - 1)));
}

/**
 * How far a newly-introduced element has travelled.
 *
 * Retained elements (established by an earlier beat of the same sequence) are
 * drawn already-complete: re-animating the walking result from zero on the
 * beat that talks about the message is exactly the "three independent resets"
 * problem, and it also makes consecutive beats look identical.
 */
function entrance(r: number, retained: boolean | undefined, index: number, count: number): number {
  if (retained) return 1;
  // Stagger multiple new elements so a viewer can follow them one at a time
  // rather than watching everything arrive at once.
  const span = 0.7 / Math.max(1, count);
  const start = 0.15 + index * span;
  return Math.max(0, Math.min(1, (r - start) / Math.max(0.001, span * 1.6)));
}

function ease(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

function seriesColor(index: number): string {
  return SERIES[index % SERIES.length]!;
}

/** Multi-line, auto-shrinking centred text that cannot leave the safe area. */
function FittedText({
  text,
  x,
  y,
  maxWidth,
  fontSize,
  maxLines = 2,
  fill = PAPER,
  weight = 800,
  anchor = "middle",
  lineHeight = 1.16,
  opacity = 1,
}: {
  text: string;
  x: number;
  y: number;
  maxWidth: number;
  fontSize: number;
  maxLines?: number;
  fill?: string;
  weight?: number;
  anchor?: "start" | "middle" | "end";
  lineHeight?: number;
  opacity?: number;
}) {
  const fitted = fitText(text, maxWidth, fontSize, maxLines);
  if (!fitted.lines.length) return null;
  return (
    <text
      x={x}
      y={y}
      fill={fill}
      fontSize={fitted.fontSize}
      fontWeight={weight}
      textAnchor={anchor}
      opacity={opacity}
      style={{fontFamily: "Inter,Arial,sans-serif"}}
    >
      {fitted.lines.map((line, index) => (
        <tspan key={index} x={x} dy={index === 0 ? 0 : fitted.fontSize * lineHeight}>
          {line}
        </tspan>
      ))}
    </text>
  );
}

function Frame({children, blueprint}: {children: React.ReactNode; blueprint: string}) {
  return (
    <svg
      data-rfc0010-scene={blueprint}
      viewBox={`0 0 ${W} ${H}`}
      style={{width: "100%", height: "100%", display: "block", background: BG}}
    >
      <defs>
        <radialGradient id="rfc0010-vignette" cx="50%" cy="44%" r="72%">
          <stop offset="0%" stopColor="#17334D" stopOpacity="0.55" />
          <stop offset="100%" stopColor={BG} stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect x="0" y="0" width={W} height={H} fill={BG} />
      <rect x="0" y="0" width={W} height={H} fill="url(#rfc0010-vignette)" />
      {children}
    </svg>
  );
}

/**
 * One shared, labelled distance/quantity scale with every mode travelling
 * along it.
 *
 * This is the shape the benchmark's speed comparison actually needed: a single
 * axis carrying its unit and maximum, one lane per mode, each lane's marker
 * parked at its own value with the rate that produced it and the time it took
 * written beside it, and the arithmetic spelled out underneath.
 */
function ScaleComparison({scene}: {scene: Rfc0010Scene}) {
  const r = progress();
  const axis = scene.axis as Rfc0010Axis;
  const markers = (scene.markers ?? []).slice(0, 4);
  const trackLeft = 620;
  const trackRight = W - SAFE_X - 40;
  const trackSpan = trackRight - trackLeft;

  const captionY = SAFE_TOP + 74;
  const firstLane = captionY + 150;
  const laneGap = 128;
  const axisY = firstLane + markers.length * laneGap - 26;

  return (
    <Frame blueprint="scale_comparison">
      <FittedText text={scene.caption} x={W / 2} y={captionY} maxWidth={SAFE_W} fontSize={62} maxLines={2} />

      {markers.map((marker, index) => {
        const y = firstLane + index * laneGap;
        const color = seriesColor(index);
        const t = ease(entrance(r, marker.retained, index, markers.length));
        const target = Math.max(0, Math.min(1, marker.value / axis.max));
        const x = trackLeft + trackSpan * target * t;
        return (
          <g key={marker.id}>
            {/* Lane name, right-aligned into the gutter so it never collides
                with the track no matter how long the label is. */}
            <FittedText
              text={marker.label}
              x={trackLeft - 44}
              y={y + 10}
              maxWidth={trackLeft - SAFE_X - 60}
              fontSize={40}
              maxLines={2}
              anchor="end"
              fill={color}
              weight={850}
            />
            <line x1={trackLeft} y1={y} x2={trackRight} y2={y} stroke="#22385A" strokeWidth={10} strokeLinecap="round" />
            <line x1={trackLeft} y1={y} x2={Math.max(trackLeft, x)} y2={y} stroke={color} strokeWidth={10} strokeLinecap="round" />
            <circle cx={x} cy={y} r={20} fill={color} />
            {marker.rate_label ? (
              <text
                x={trackLeft + 14}
                y={y - 30}
                fill={MUTED}
                fontSize={34}
                fontWeight={800}
                style={{fontFamily: "Inter,Arial,sans-serif"}}
              >
                {marker.rate_label}
              </text>
            ) : null}
            {marker.time_label ? (
              <text
                x={Math.min(trackRight, x + 34)}
                y={y - 30}
                fill={color}
                fontSize={38}
                fontWeight={900}
                textAnchor={x > trackLeft + trackSpan * 0.72 ? "end" : "start"}
                opacity={t}
                style={{fontFamily: "Inter,Arial,sans-serif"}}
              >
                {marker.time_label}
              </text>
            ) : null}
          </g>
        );
      })}

      {/* The shared scale itself: origin, maximum, unit, and what it measures. */}
      <line x1={trackLeft} y1={axisY} x2={trackRight} y2={axisY} stroke={PAPER} strokeWidth={5} />
      {[0, 0.25, 0.5, 0.75, 1].map((stop) => (
        <line
          key={stop}
          x1={trackLeft + trackSpan * stop}
          y1={axisY}
          x2={trackLeft + trackSpan * stop}
          y2={axisY + (stop === 0 || stop === 1 ? 26 : 16)}
          stroke={PAPER}
          strokeWidth={4}
        />
      ))}
      <text x={trackLeft} y={axisY + 74} fill={PAPER} fontSize={38} fontWeight={800} textAnchor="middle" style={{fontFamily: "Inter,Arial,sans-serif"}}>
        {`0 ${axis.unit}`}
      </text>
      <text x={trackRight} y={axisY + 74} fill={PAPER} fontSize={38} fontWeight={800} textAnchor="middle" style={{fontFamily: "Inter,Arial,sans-serif"}}>
        {`${axis.max} ${axis.unit}`}
      </text>
      <FittedText
        text={axis.label}
        x={(trackLeft + trackRight) / 2}
        y={axisY + 76}
        maxWidth={trackSpan * 0.5}
        fontSize={34}
        maxLines={1}
        fill={MUTED}
        weight={700}
      />

      {scene.equation ? (
        <FittedText
          text={scene.equation}
          x={W / 2}
          y={Math.min(SAFE_BOTTOM - 10, axisY + 172)}
          maxWidth={SAFE_W}
          fontSize={72}
          maxLines={1}
          fill={ACCENT}
          weight={900}
          opacity={Math.max(0, Math.min(1, (r - 0.35) / 0.2))}
        />
      ) : null}
    </Frame>
  );
}

/** Ordered stages along one line: each node is a real labelled stop. */
function TimelineOrProcess({scene, kind}: {scene: Rfc0010Scene; kind: "timeline" | "process"}) {
  const r = progress();
  const nodes = ((kind === "timeline" ? scene.nodes : scene.steps) ?? []).slice(0, 5) as Rfc0010Node[];
  const captionY = SAFE_TOP + 74;
  const lineY = 600;
  const left = SAFE_X + 120;
  const right = W - SAFE_X - 120;
  const step = nodes.length > 1 ? (right - left) / (nodes.length - 1) : 0;
  const slot = Math.min(340, step || 340);

  return (
    <Frame blueprint={kind}>
      <FittedText text={scene.caption} x={W / 2} y={captionY} maxWidth={SAFE_W} fontSize={62} maxLines={2} />
      <line x1={left} y1={lineY} x2={right} y2={lineY} stroke="#22385A" strokeWidth={10} strokeLinecap="round" />
      {nodes.map((node, index) => {
        const x = left + step * index;
        const t = ease(entrance(r, node.retained, index, nodes.length));
        const color = seriesColor(index);
        return (
          <g key={node.id} opacity={0.25 + 0.75 * t}>
            {index > 0 ? (
              <line
                x1={left + step * (index - 1)}
                y1={lineY}
                x2={left + step * (index - 1) + step * t}
                y2={lineY}
                stroke={color}
                strokeWidth={10}
                strokeLinecap="round"
              />
            ) : null}
            <circle cx={x} cy={lineY} r={26 + 8 * t} fill={color} />
            <FittedText text={node.label} x={x} y={lineY - 90} maxWidth={slot} fontSize={40} maxLines={2} weight={850} />
            {node.sub_label ? (
              <FittedText text={node.sub_label} x={x} y={lineY + 84} maxWidth={slot} fontSize={34} maxLines={2} fill={MUTED} weight={700} />
            ) : null}
          </g>
        );
      })}
    </Frame>
  );
}

/** Two named states with the transition between them made explicit. */
function BeforeAfter({scene}: {scene: Rfc0010Scene}) {
  const r = progress();
  const t = ease(Math.max(0, Math.min(1, (r - 0.2) / 0.5)));
  const captionY = SAFE_TOP + 74;
  const panelY = 300;
  const panelH = 420;
  const panelW = 700;
  const midY = panelY + panelH / 2;

  const panel = (node: Rfc0010Node | undefined, x: number, color: string, opacity: number) =>
    node ? (
      <g opacity={opacity}>
        <rect x={x} y={panelY} width={panelW} height={panelH} rx={36} fill="#12294A" stroke={color} strokeWidth={7} />
        <FittedText text={node.label} x={x + panelW / 2} y={midY - 10} maxWidth={panelW - 90} fontSize={54} maxLines={3} weight={880} />
        {node.sub_label ? (
          <FittedText text={node.sub_label} x={x + panelW / 2} y={panelY + panelH - 56} maxWidth={panelW - 90} fontSize={36} maxLines={2} fill={MUTED} weight={700} />
        ) : null}
      </g>
    ) : null;

  return (
    <Frame blueprint="before_after">
      <FittedText text={scene.caption} x={W / 2} y={captionY} maxWidth={SAFE_W} fontSize={62} maxLines={2} />
      {panel(scene.before, SAFE_X, BLUE, 1)}
      <path
        d={`M${SAFE_X + panelW + 40} ${midY} L${W - SAFE_X - panelW - 40} ${midY}`}
        stroke={ACCENT}
        strokeWidth={10}
        strokeLinecap="round"
        opacity={0.25 + 0.75 * t}
      />
      <path
        d={`M${W - SAFE_X - panelW - 92} ${midY - 30} L${W - SAFE_X - panelW - 40} ${midY} L${W - SAFE_X - panelW - 92} ${midY + 30}`}
        fill="none"
        stroke={ACCENT}
        strokeWidth={10}
        strokeLinecap="round"
        opacity={t}
      />
      {panel(scene.after, W - SAFE_X - panelW, GREEN, 0.3 + 0.7 * t)}
    </Frame>
  );
}

/** Named quantities drawn to scale against each other, with their numbers. */
function Quantity({scene}: {scene: Rfc0010Scene}) {
  const r = progress();
  const items = (scene.items ?? []).slice(0, 5);
  const max = Math.max(...items.map((item) => Math.abs(item.value)), 1);
  const captionY = SAFE_TOP + 74;
  const first = captionY + 150;
  const gap = Math.min(140, (SAFE_BOTTOM - first) / Math.max(1, items.length));
  const barLeft = 620;
  const barMax = W - SAFE_X - barLeft - 220;

  return (
    <Frame blueprint="quantity">
      <FittedText text={scene.caption} x={W / 2} y={captionY} maxWidth={SAFE_W} fontSize={62} maxLines={2} />
      {items.map((item, index) => {
        const y = first + index * gap;
        const color = seriesColor(index);
        const t = ease(entrance(r, item.retained, index, items.length));
        const width = barMax * (Math.abs(item.value) / max) * t;
        return (
          <g key={item.id}>
            <FittedText
              text={item.label}
              x={barLeft - 44}
              y={y + 12}
              maxWidth={barLeft - SAFE_X - 60}
              fontSize={40}
              maxLines={2}
              anchor="end"
              fill={color}
              weight={850}
            />
            <rect x={barLeft} y={y - 34} width={Math.max(6, width)} height={68} rx={14} fill={color} />
            <text
              x={barLeft + Math.max(6, width) + 28}
              y={y + 16}
              fill={PAPER}
              fontSize={44}
              fontWeight={900}
              opacity={t}
              style={{fontFamily: "Inter,Arial,sans-serif"}}
            >
              {item.rate_label ?? item.time_label ?? String(item.value)}
            </text>
          </g>
        );
      })}
    </Frame>
  );
}

/**
 * The honest fallback: a short phrase with one emphasised value.
 *
 * Deliberately not a fake infographic. When no semantic representation fits,
 * drawing empty boxes around the words is worse than typography, because the
 * boxes claim a structure the beat does not have -- which is precisely how the
 * old renderer produced "generic filler" on six of ten beats.
 */
function KineticPhrase({scene}: {scene: Rfc0010Scene}) {
  const r = progress();
  const lines = (scene.lines ?? []).slice(0, 3);
  if (!lines.length) return <Frame blueprint="kinetic_phrase">{null}</Frame>;

  const emphasisIndex = Math.max(0, lines.findIndex((line) => line.emphasis));
  const sizes = lines.map((line) => (line.emphasis ? 132 : 62));
  const heights = lines.map((_, index) => sizes[index]! * 1.2);
  const total = heights.reduce((sum, value) => sum + value, 0);
  let cursor = (SAFE_TOP + SAFE_BOTTOM) / 2 - total / 2 + sizes[0]! * 0.8;

  const positioned = lines.map((line, index) => {
    const y = cursor;
    cursor += heights[index]!;
    return {line, y, size: sizes[index]!};
  });

  return (
    <Frame blueprint="kinetic_phrase">
      {positioned.map(({line, y, size}, index) => {
        const appear = Math.max(0, Math.min(1, (r - 0.08 - index * 0.12) / 0.22));
        return (
          <g key={index} opacity={appear} transform={`translate(0 ${(1 - ease(appear)) * 26})`}>
            <FittedText
              text={line.text}
              x={W / 2}
              y={y}
              maxWidth={SAFE_W}
              fontSize={size}
              maxLines={line.emphasis ? 2 : 1}
              fill={line.emphasis ? ACCENT : PAPER}
              weight={line.emphasis ? 930 : 800}
            />
          </g>
        );
      })}
      <rect
        x={W / 2 - 300}
        y={positioned[emphasisIndex]!.y + 44}
        width={600 * Math.max(0, Math.min(1, (r - 0.3) / 0.4))}
        height={9}
        rx={5}
        fill={GREEN}
        transform={`translate(${-300 * Math.max(0, Math.min(1, (r - 0.3) / 0.4)) + 300} 0)`}
      />
    </Frame>
  );
}

export function Rfc0010SceneRenderer({scene}: {scene: Rfc0010Scene}) {
  switch (scene.kind) {
    case "scale_comparison":
      return scene.axis ? <ScaleComparison scene={scene} /> : <KineticPhrase scene={scene} />;
    case "timeline":
      return <TimelineOrProcess scene={scene} kind="timeline" />;
    case "process":
      return <TimelineOrProcess scene={scene} kind="process" />;
    case "before_after":
      return <BeforeAfter scene={scene} />;
    case "quantity":
      return <Quantity scene={scene} />;
    case "kinetic_phrase":
    default:
      return <KineticPhrase scene={scene} />;
  }
}
