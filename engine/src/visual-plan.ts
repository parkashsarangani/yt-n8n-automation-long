import { createHash } from "node:crypto";
import type {
  EpisodeVisualReference,
  VisualKind,
  VisualOverlay,
  VisualPlan,
  VisualPlanBeat,
} from "./provider.ts";

export interface VisualPlanScene {
  scene_index: number;
  point?: string;
  narration?: string;
  is_outro?: boolean;
}

export interface VisualPlanOptions {
  lessonTitle?: string;
  maxArtwork?: number;
}

const EVIDENCE_WORDS = /\b(record|recording|message|email|notice|proof|evidence|receipt|agreement|quote|screenshot|detail|document)\b/i;
const COMPARISON_WORDS = /\b(compare|instead|rather|choice|response|respond|answer|before|after|edited|complete|interrupt|boundary|pressure)\b/i;
const TIMELINE_WORDS = /\b(first|then|next|later|finally|step|sequence|pattern|date|timeline|practice|exercise)\b/i;
const PAYOFF_WORDS = /\b(payoff|outcome|resolved|resolution|result|lesson|takeaway|finally|unpack|suitcase|closing)\b/i;

function clean(value: unknown, max = 180): string {
  return String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .trim();
}

function roleOf(scene: VisualPlanScene): string {
  const marker = /^\s*\[([^\]]+)\]/.exec(scene.point ?? "");
  return (marker?.[1] ?? scene.point ?? "").toLowerCase();
}

function referenceOf(scene: VisualPlanScene): string {
  const point = clean(scene.point, 130).replace(/^\[[^\]]+\]\s*/, "");
  if (point.length >= 12) return point;
  const sentence = clean(scene.narration, 150).match(/^.*?[.!?](?:\s|$)/)?.[0];
  return clean(sentence || scene.narration, 150) || "The next story beat";
}

function kindOf(scene: VisualPlanScene, index: number): VisualKind {
  const text = `${scene.point ?? ""} ${scene.narration ?? ""}`;
  const role = roleOf(scene);
  if (scene.is_outro || PAYOFF_WORDS.test(text) || /payoff|takeaway|outro/.test(role)) return "payoff";
  if (EVIDENCE_WORDS.test(text)) return "document";
  if (COMPARISON_WORDS.test(text) || /response|choice|interruption|boundary/.test(role)) return "comparison";
  if (TIMELINE_WORDS.test(text) || /exercise|practice|sequence/.test(role)) return "timeline";
  if (index === 0 || /hook|scenario|situation|setup/.test(role)) return "artwork";
  if (/explanation|context|limitation|why/.test(role)) return "document";
  if (/response|example|dialogue/.test(role)) return "comparison";
  return index % 3 === 0 ? "artwork" : "document";
}

function overlayOf(kind: VisualKind, reference: string): VisualOverlay {
  switch (kind) {
    case "document":
      return {
        eyebrow: "KEEP THE DETAIL VISIBLE",
        title: "What actually happened",
        body: reference,
      };
    case "comparison":
      return {
        eyebrow: "COMPARE THE RESPONSE",
        left_label: "THE MOMENT",
        left_text: reference,
        right_label: "THE NEXT MOVE",
        right_text: "Pause, choose, then speak clearly",
      };
    case "timeline":
      return {
        eyebrow: "THE SEQUENCE",
        title: "Make the next step visible",
        steps: [reference, "Pause and choose", "Carry it forward"],
      };
    case "payoff":
      return {
        eyebrow: "TAKE THIS WITH YOU",
        title: "The useful part is the choice",
        body: reference,
      };
    case "artwork":
      return { eyebrow: "THE SITUATION", body: reference };
  }
}

function viewerUnderstands(kind: VisualKind): string {
  switch (kind) {
    case "artwork": return "See the people and setting before the next response.";
    case "document": return "Notice the concrete detail that can be checked or remembered.";
    case "comparison": return "See the difference between the automatic response and a deliberate next move.";
    case "timeline": return "Follow the sequence instead of receiving several abstract instructions at once.";
    case "payoff": return "Connect the result to the practical choice the episode taught.";
  }
}

function referenceFor(scenes: VisualPlanScene[], lessonTitle?: string): EpisodeVisualReference {
  const seed = JSON.stringify({
    title: clean(lessonTitle, 120),
    scenes: scenes.map((scene) => ({ scene_index: scene.scene_index, point: clean(scene.point, 120) })),
  });
  const id = createHash("sha256").update(seed).digest("hex").slice(0, 16);
  return {
    id: `quiet-signal-${id}`,
    subject: "the same contemporary adult subject throughout the episode",
    setting: "the setting established by each scene, with believable continuity between related beats",
    wardrobe: "the same understated contemporary outfit in related beats; no costume changes without a script reason",
    palette: "charcoal, deep teal, warm ivory, and one restrained amber accent",
  };
}

/**
 * Build the visual plan only from the approved script. The plan is bounded by
 * scene count and artwork budget, so it cannot turn one sentence into a paid
 * image-generation request for every frame.
 */
export function buildVisualPlan(scenes: VisualPlanScene[], options: VisualPlanOptions = {}): VisualPlan {
  const ordered = [...scenes].sort((a, b) => a.scene_index - b.scene_index);
  const maxArtwork = Math.max(1, Math.min(6, options.maxArtwork ?? 4));
  const reference = referenceFor(ordered, options.lessonTitle);
  const kinds = ordered.map((scene, index) => kindOf(scene, index));
  const artworkIndexes = kinds
    .map((kind, index) => kind === "artwork" ? index : -1)
    .filter((index) => index >= 0)
    .slice(0, maxArtwork);
  if (artworkIndexes.length === 0 && ordered.length > 0) artworkIndexes.push(0);
  const artworkSet = new Set(artworkIndexes);

  const beats: VisualPlanBeat[] = ordered.map((scene, index) => {
    const kind = kinds[index]!;
    const sceneReference = referenceOf(scene);
    return {
      scene_index: scene.scene_index,
      kind,
      viewer_understands: viewerUnderstands(kind),
      scene_reference: sceneReference,
      requires_artwork: kind === "artwork" && artworkSet.has(index),
      overlay: overlayOf(kind, sceneReference),
    };
  });

  return { version: "1", reference, beats };
}

export function visualPrompt(plan: VisualPlan, beat: VisualPlanBeat): string {
  return [
    "Create one text-free editorial illustration for a YouTube episode.",
    "Do not render letters, words, captions, signs, logos, screens, watermarks, or readable writing.",
    `Episode continuity reference ${plan.reference.id}: ${plan.reference.subject}.`,
    `Setting continuity: ${plan.reference.setting}. Wardrobe continuity: ${plan.reference.wardrobe}. Palette: ${plan.reference.palette}.`,
    `Visual purpose: ${beat.viewer_understands}`,
    `Scene reference (illustrate the situation, never render this text): ${beat.scene_reference}`,
    "Keep faces and the important interaction in the upper-right half; leave the top and bottom overlay bands quiet.",
  ].join(" ");
}
