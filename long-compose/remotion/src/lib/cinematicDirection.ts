import type { CSSProperties } from "react";

export type CinematicShotRecipe =
    | "establishing"
    | "two-shot"
    | "reaction-closeup"
    | "prop-insert"
    | "over-shoulder"
    | "crossing-transition"
    | "callback-reveal"
    | "payoff-hold";

export type CinematicTransition =
    | "cut"
    | "soft-push-left"
    | "soft-push-right"
    | "doorway-slide"
    | "prop-match-cut"
    | "reaction-pop-cut";

export type CinematicCameraIntent =
    | "static"
    | "slow-push"
    | "reaction-push"
    | "prop-focus"
    | "doorway-track"
    | "payoff-hold";

export type PhysicalPropPlacement =
    | "hand-held"
    | "on-table"
    | "on-counter"
    | "floor"
    | "wall-mounted"
    | "background-set-piece"
    | "ui-badge";

export type ActingPreset =
    | "neutral-hold"
    | "notices-prop"
    | "deadpan-side-eye"
    | "double-take"
    | "small-defeat"
    | "reluctant-acceptance"
    | "walk-cross"
    | "payoff-freeze";

export interface CinematicSceneSpec {
    shotRecipe?: CinematicShotRecipe | string;
    transition?: CinematicTransition | string;
    cameraIntent?: CinematicCameraIntent | string;
    propPlacement?: PhysicalPropPlacement | string;
    propMode?: "physical" | "badge" | string;
    sceneRole?: "setup" | "crossing" | "room-a" | "room-b" | "return" | "payoff" | "mechanism" | string;
    continuityGroup?: string;
    sfxCue?: "none" | "soft-hit" | "room-change" | "prop" | "reaction" | "payoff" | string;
    actingPreset?: ActingPreset | string;
    qualityTags?: string[];
}

export interface ForegroundPropLike {
    type?: string;
    anchor?: string;
    state?: string;
    motion?: string;
}

export interface BackgroundLike {
    location?: string;
    variant?: string;
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function easeOutCubic(t: number): number {
    const p = clamp(t, 0, 1);
    return 1 - Math.pow(1 - p, 3);
}

function easeInOutCubic(t: number): number {
    const p = clamp(t, 0, 1);
    return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
}

function normalized(value?: string): string {
    return String(value ?? "").toLowerCase().trim();
}

export function normalizedShotRecipe(value?: string): CinematicShotRecipe {
    switch (normalized(value)) {
        case "establishing": return "establishing";
        case "reaction-closeup":
        case "reaction-close-up": return "reaction-closeup";
        case "prop-insert": return "prop-insert";
        case "over-shoulder": return "over-shoulder";
        case "crossing-transition":
        case "doorway-transition": return "crossing-transition";
        case "callback-reveal": return "callback-reveal";
        case "payoff-hold": return "payoff-hold";
        case "two-shot":
        default: return "two-shot";
    }
}

export function actingPresetFor(cinematic: CinematicSceneSpec | undefined): ActingPreset {
    const requested = normalized(cinematic?.actingPreset);
    switch (requested) {
        case "notices-prop":
        case "deadpan-side-eye":
        case "double-take":
        case "small-defeat":
        case "reluctant-acceptance":
        case "walk-cross":
        case "payoff-freeze":
        case "neutral-hold":
            return requested;
    }
    const recipe = normalizedShotRecipe(cinematic?.shotRecipe);
    const role = normalized(cinematic?.sceneRole);
    if (recipe === "crossing-transition" || role === "crossing") return "walk-cross";
    if (recipe === "reaction-closeup") return "double-take";
    if (recipe === "prop-insert") return "notices-prop";
    if (recipe === "payoff-hold" || role === "payoff") return "payoff-freeze";
    if (role === "return") return "reluctant-acceptance";
    return "neutral-hold";
}

export function cinematicCameraStyle(cinematic: CinematicSceneSpec | undefined, frame: number, durationInFrames: number): CSSProperties {
    const recipe = normalizedShotRecipe(cinematic?.shotRecipe);
    const intent = normalized(cinematic?.cameraIntent);
    const progress = durationInFrames <= 1 ? 1 : clamp(frame / Math.max(1, durationInFrames - 1), 0, 1);
    const e = easeInOutCubic(progress);
    const entry = easeOutCubic(Math.min(frame, 12) / 12);

    let scale = 1;
    let x = 0;
    let y = 0;

    switch (recipe) {
        case "establishing":
            scale = 0.985 + e * 0.025;
            y = 3 - e * 3;
            break;
        case "reaction-closeup":
            scale = 1.025 + e * 0.055;
            y = 4 - e * 4;
            break;
        case "prop-insert":
            scale = 1.04 + e * 0.035;
            x = -10 + e * 18;
            break;
        case "over-shoulder":
            scale = 1.015 + e * 0.025;
            x = -8 + e * 12;
            break;
        case "crossing-transition":
            scale = 1.02;
            x = -42 + entry * 42;
            break;
        case "callback-reveal":
            scale = 1.01 + e * 0.035;
            x = 8 - e * 8;
            break;
        case "payoff-hold":
            scale = 1.018;
            break;
        case "two-shot":
            scale = intent === "slow-push" ? 1 + e * 0.024 : 1;
            break;
    }

    if (intent === "doorway-track") x += -22 + entry * 22;
    if (intent === "reaction-push") scale += e * 0.025;
    if (intent === "prop-focus") scale += e * 0.02;

    const transform = `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0) scale(${scale.toFixed(4)})`;
    return { transform, transformOrigin: "50% 58%" };
}

export function cinematicTransitionStyle(cinematic: CinematicSceneSpec | undefined, frame: number): CSSProperties {
    const transition = normalized(cinematic?.transition);
    const enter = easeOutCubic(Math.min(frame, 10) / 10);
    switch (transition) {
        case "soft-push-left": return { transform: `translateX(${(1 - enter) * 46}px)`, opacity: 0.72 + enter * 0.28 };
        case "soft-push-right": return { transform: `translateX(${(enter - 1) * 46}px)`, opacity: 0.72 + enter * 0.28 };
        case "doorway-slide": return { transform: `translateX(${(1 - enter) * 90}px)`, opacity: 0.66 + enter * 0.34 };
        case "prop-match-cut": return { transform: `scale(${(0.985 + enter * 0.015).toFixed(4)})`, opacity: 0.78 + enter * 0.22 };
        case "reaction-pop-cut": return { transform: `scale(${(0.96 + enter * 0.04).toFixed(4)})`, opacity: 0.8 + enter * 0.2 };
        case "cut":
        default: return {};
    }
}

export function cinematicOverlayStyle(cinematic: CinematicSceneSpec | undefined): CSSProperties | null {
    const recipe = normalizedShotRecipe(cinematic?.shotRecipe);
    const cue = normalized(cinematic?.sfxCue);
    if (cue === "room-change") {
        return { background: "linear-gradient(90deg, rgba(255,255,255,0.00), rgba(255,255,255,0.20), rgba(56,189,248,0.10), rgba(255,255,255,0.00))", opacity: 0.50 };
    }
    if (cue === "reaction") {
        return { background: "radial-gradient(circle at 50% 42%, rgba(250,204,21,0.18) 0 18%, transparent 42%)", opacity: 0.44 };
    }
    if (cue === "prop") {
        return { background: "radial-gradient(circle at 72% 66%, rgba(255,255,255,0.22), transparent 30%)", opacity: 0.42 };
    }
    switch (recipe) {
        case "payoff-hold":
            return { background: "radial-gradient(circle at 50% 62%, transparent 0 46%, rgba(15,23,42,0.10) 82%)", opacity: 0.58 };
        case "callback-reveal":
            return { background: "linear-gradient(120deg, transparent 0 50%, rgba(255,255,255,0.16) 56%, transparent 64%)", opacity: 0.45 };
        case "crossing-transition":
            return { background: "linear-gradient(90deg, rgba(255,255,255,0.00), rgba(255,255,255,0.16), rgba(255,255,255,0.00))", opacity: 0.42 };
        default:
            return null;
    }
}

export function propPlacementFor(background: BackgroundLike | undefined, prop: ForegroundPropLike | undefined, cinematic: CinematicSceneSpec | undefined): PhysicalPropPlacement {
    const requested = normalized(cinematic?.propPlacement || prop?.anchor);
    switch (requested) {
        case "hand":
        case "hand-held": return "hand-held";
        case "table":
        case "on-table": return "on-table";
        case "counter":
        case "on-counter": return "on-counter";
        case "floor": return "floor";
        case "wall":
        case "wall-mounted": return "wall-mounted";
        case "background":
        case "background-set-piece": return "background-set-piece";
        case "badge":
        case "ui":
        case "ui-badge": return "ui-badge";
    }

    const location = normalized(background?.location);
    const type = normalized(prop?.type);
    if (["clock", "calendar", "window", "door"].includes(type)) return "wall-mounted";
    if (["shoes", "vehicle", "car"].includes(type)) return "floor";
    if (["coffee", "kettle", "food", "document", "bill", "letter", "keys", "laptop", "route-map", "map"].includes(type)) {
        return location === "kitchen" || location === "cafe" || location === "shop" ? "on-counter" : "on-table";
    }
    if (["phone", "charger", "phone-charger"].includes(type)) return "hand-held";
    return "on-table";
}

export function shouldRenderPropAsBadge(prop: ForegroundPropLike | undefined, placement: PhysicalPropPlacement, cinematic: CinematicSceneSpec | undefined): boolean {
    if (normalized(cinematic?.propMode) === "badge") return true;
    if (placement === "ui-badge") return true;
    const state = normalized(prop?.state);
    return /abstract|score|notification-badge|ui-only/.test(state);
}

export function cinematicCharacterLayerStyle(cinematic: CinematicSceneSpec | undefined): CSSProperties {
    const recipe = normalizedShotRecipe(cinematic?.shotRecipe);
    const preset = actingPresetFor(cinematic);
    const base: CSSProperties = (() => {
        switch (recipe) {
            case "establishing": return { transformOrigin: "50% 80%" };
            case "prop-insert": return { transformOrigin: "64% 82%" };
            case "reaction-closeup": return { transformOrigin: "50% 74%" };
            case "crossing-transition": return { transformOrigin: "45% 80%" };
            default: return { transformOrigin: "50% 78%" };
        }
    })();
    return { ...base, filter: preset === "payoff-freeze" ? "drop-shadow(0 10px 18px rgba(15,23,42,0.14))" : base.filter };
}

export function cinematicActingStageTransform(cinematic: CinematicSceneSpec | undefined, frame: number, durationInFrames = 120): string {
    const preset = actingPresetFor(cinematic);
    const beat = Math.sin(frame / 5.8);
    const slow = Math.sin(frame / 18);
    switch (preset) {
        case "walk-cross": {
            // Crossing is a shot-level blocking action, not a 0.7s entrance flourish.
            // Keep the actor travelling through the frame so early/mid/late states
            // are compositionally distinct and the move reads as physical staging.
            const travel = easeInOutCubic(clamp(frame / Math.max(1, durationInFrames - 1), 0, 1));
            const x = 90 - travel * 480;
            return `translateX(${x.toFixed(2)}px) translateY(${(Math.abs(beat) * -8).toFixed(2)}px) rotate(${(beat * 0.45).toFixed(2)}deg)`;
        }
        case "double-take":
            return `translateX(${(frame < 8 ? -16 + frame * 2 : slow * 4).toFixed(2)}px) rotate(${(frame < 8 ? -1.8 + frame * 0.28 : slow * 0.55).toFixed(2)}deg)`;
        case "notices-prop":
            return `translateY(${(Math.min(frame, 12) / 12 * -12).toFixed(2)}px) scale(${(1 + Math.min(frame, 12) / 12 * 0.018).toFixed(3)})`;
        case "small-defeat":
            return `translateY(${(Math.min(frame, 18) / 18 * 6).toFixed(2)}px) rotate(${(slow * -0.25).toFixed(2)}deg)`;
        case "reluctant-acceptance":
            return `translateY(${(Math.sin(frame / 24) * 2).toFixed(2)}px) rotate(${(Math.sin(frame / 30) * 0.22).toFixed(2)}deg)`;
        case "payoff-freeze":
            return `translateY(${(Math.sin(frame / 46) * 1.2).toFixed(2)}px)`;
        case "deadpan-side-eye":
        case "neutral-hold":
        default:
            return "";
    }
}
