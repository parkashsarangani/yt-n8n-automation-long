import type { SemanticSceneProps } from "./types";
import {
  ACCENT,
  BLUE,
  GREEN,
  RED,
  TEAL,
  actionSlot,
  entityColor,
  entityLabel,
  ratio,
} from "./shared";

export function ContainerObjectScene(x: SemanticSceneProps) {
  const r = ratio();
  const a = x.semanticActionWindows;
  // hasDropAction used to gate `drop` to a hardcoded 1 (fully settled)
  // whenever the plan didn't author a literal "drop"/"enter" verb -- which
  // was the majority of real plans (see actionSlot's comment in shared.tsx).
  // Falling to a constant 1 instead of animating was the same "renders
  // static" bug as the other two slots; actionSlot covers all three
  // uniformly now, so the object animates using whatever verbs were
  // actually authored instead of only ever settling instantly.
  const drop = actionSlot(r, a, ["drop", "enter"]);
  const rise = actionSlot(r, a, ["rise"]);
  // skew=1.8: rise and sink push the object in opposite directions with
  // near-equal magnitude (-130*rise, +135*sink below); when neither verb was
  // authored, both would otherwise ramp through the exact same fallback
  // span in lockstep and nearly cancel out (see actionSlot's comment in
  // shared.tsx). The skew keeps sink smooth and monotonic but desyncs it
  // from rise enough that their combined effect on `y` is actually visible.
  const sink = actionSlot(r, a, ["sink"], 1.8);
  const y = 75 + 205 * drop - 130 * rise + 135 * sink;

  return (
    <svg
      data-semantic-blueprint="container-object"
      viewBox="0 0 1100 520"
      style={{ width: "100%", maxWidth: 1450 }}
    >
      <path
        d="M270 80 L320 455 Q325 480 360 480 H740 Q775 480 780 455 L830 80"
        fill="#0C1C31"
        stroke={BLUE}
        strokeWidth="9"
      />
      <path d="M315 190 H785 L752 450 H348 Z" fill={entityColor(x, 1, "#163A5C")} />
      <path
        d="M315 190 Q450 178 550 190 T785 190"
        fill="none"
        stroke={TEAL}
        strokeWidth="7"
      />
      <g transform={`translate(550 ${y})`}>
        <rect
          x="-66"
          y="-66"
          width="132"
          height="132"
          rx="30"
          fill={`${entityColor(x, 0, ACCENT)}55`}
          stroke={entityColor(x, 0, ACCENT)}
          strokeWidth="8"
        />
      </g>
      <text x="550" y="45" fill={ACCENT} fontSize="38" fontWeight="900" textAnchor="middle">
        {entityLabel(x, 0, "object")}
      </text>
      <text x="925" y="250" fill={TEAL} fontSize="34" fontWeight="850" textAnchor="middle">
        {entityLabel(x, 1, "medium")}
      </text>
      {rise > 0.05 || sink > 0.05 ? (
        <path
          d={
            rise > sink
              ? "M190 320 L190 185 M170 210 L190 180 L210 210"
              : "M190 185 L190 330 M170 305 L190 335 L210 305"
          }
          fill="none"
          stroke={rise > sink ? GREEN : RED}
          strokeWidth="10"
        />
      ) : null}
    </svg>
  );
}
