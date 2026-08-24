import type { BackgroundSpec } from "../components/Background";
import type { CharacterProps } from "../components/Character";

export type SceneShotType = "wide" | "medium" | "close-up" | "prop-close-up" | "doorway-transition" | "counter-shot" | "table-shot" | string;

export interface CharacterSlot {
    x: number;
    y: number;
    scale: number;
    zIndex: number;
    gaze?: "left" | "right" | "camera" | "auto";
}

export interface SceneDepthZone {
    name: "background" | "midground" | "performance" | "foreground";
    yMin: number;
    yMax: number;
    scale: number;
}

export interface SceneCompositionProfile {
    location: string;
    horizonY: number;
    groundY: number;
    floorContactY: number;
    defaultShot: "establishing" | "two-shot" | "counter-shot" | "close-up";
    cameraBias: "left" | "center" | "right";
    depthZones: SceneDepthZone[];
    slots: {
        solo: CharacterSlot[];
        pair: CharacterSlot[];
        group: CharacterSlot[];
    };
    foregroundMask?: "counter" | "desk" | "car-dashboard" | "cafe-table" | "shop-counter" | "hospital-bed" | "none";
    notes: string;
}

const DEFAULT_PROFILE: SceneCompositionProfile = {
    location: "generic-room",
    horizonY: 430,
    groundY: 805,
    floorContactY: 850,
    defaultShot: "two-shot",
    cameraBias: "center",
    depthZones: [
        { name: "background", yMin: 0, yMax: 420, scale: 0.82 },
        { name: "midground", yMin: 420, yMax: 650, scale: 0.94 },
        { name: "performance", yMin: 650, yMax: 900, scale: 1.0 },
        { name: "foreground", yMin: 900, yMax: 1080, scale: 1.08 },
    ],
    slots: {
        solo: [{ x: 710, y: 230, scale: 0.94, zIndex: 4, gaze: "camera" }],
        pair: [
            { x: 500, y: 246, scale: 0.92, zIndex: 4, gaze: "right" },
            { x: 900, y: 246, scale: 0.92, zIndex: 4, gaze: "left" },
        ],
        group: [
            { x: 370, y: 258, scale: 0.86, zIndex: 3, gaze: "right" },
            { x: 700, y: 232, scale: 0.94, zIndex: 5, gaze: "camera" },
            { x: 1040, y: 258, scale: 0.86, zIndex: 3, gaze: "left" },
        ],
    },
    foregroundMask: "none",
    notes: "Safe generic blocking with feet grounded below the horizon line.",
};

const profile = (partial: Partial<SceneCompositionProfile> & Pick<SceneCompositionProfile, "location">): SceneCompositionProfile => ({
    ...DEFAULT_PROFILE,
    ...partial,
    depthZones: partial.depthZones ?? DEFAULT_PROFILE.depthZones,
    slots: partial.slots ?? DEFAULT_PROFILE.slots,
});

export const SCENE_COMPOSITION_PROFILES: Record<string, SceneCompositionProfile> = {
    "living-room": profile({
        location: "living-room",
        horizonY: 410,
        groundY: 792,
        floorContactY: 842,
        defaultShot: "two-shot",
        cameraBias: "center",
        foregroundMask: "none",
        slots: {
            solo: [{ x: 720, y: 224, scale: 0.96, zIndex: 5, gaze: "camera" }],
            pair: [
                { x: 480, y: 238, scale: 0.92, zIndex: 5, gaze: "right" },
                { x: 900, y: 238, scale: 0.92, zIndex: 5, gaze: "left" },
            ],
            group: DEFAULT_PROFILE.slots.group,
        },
        notes: "Characters stand in the sofa foreground, not on the back wall.",
    }),
    hallway: profile({
        location: "hallway",
        horizonY: 380,
        groundY: 815,
        floorContactY: 868,
        defaultShot: "establishing",
        cameraBias: "left",
        foregroundMask: "none",
        slots: {
            solo: [{ x: 760, y: 224, scale: 0.93, zIndex: 4, gaze: "camera" }],
            pair: [
                { x: 570, y: 236, scale: 0.90, zIndex: 4, gaze: "right" },
                { x: 960, y: 236, scale: 0.90, zIndex: 4, gaze: "left" },
            ],
            group: DEFAULT_PROFILE.slots.group,
        },
        notes: "Doorway scenes use deeper perspective and a left-biased transition lane.",
    }),
    kitchen: profile({
        location: "kitchen",
        horizonY: 430,
        groundY: 805,
        floorContactY: 850,
        defaultShot: "two-shot",
        cameraBias: "right",
        foregroundMask: "counter",
        slots: {
            solo: [{ x: 730, y: 234, scale: 0.92, zIndex: 4, gaze: "camera" }],
            pair: [
                { x: 520, y: 246, scale: 0.90, zIndex: 4, gaze: "right" },
                { x: 930, y: 246, scale: 0.90, zIndex: 4, gaze: "left" },
            ],
            group: DEFAULT_PROFILE.slots.group,
        },
        notes: "Keep actors in front of the counter and use counter mask for foreground integration.",
    }),
    office: profile({
        location: "office",
        horizonY: 420,
        groundY: 800,
        floorContactY: 846,
        defaultShot: "counter-shot",
        cameraBias: "center",
        foregroundMask: "desk",
        slots: {
            solo: [{ x: 720, y: 238, scale: 0.92, zIndex: 4, gaze: "camera" }],
            pair: [
                { x: 510, y: 250, scale: 0.90, zIndex: 4, gaze: "right" },
                { x: 920, y: 250, scale: 0.90, zIndex: 4, gaze: "left" },
            ],
            group: DEFAULT_PROFILE.slots.group,
        },
        notes: "Desk foreground and screen background create professional explainer depth.",
    }),
    bedroom: profile({ location: "bedroom", horizonY: 410, groundY: 806, floorContactY: 850, defaultShot: "two-shot", cameraBias: "right", foregroundMask: "none", notes: "Bed is a background anchor; actors remain in the open floor lane." }),
    classroom: profile({ location: "classroom", horizonY: 392, groundY: 810, floorContactY: 856, defaultShot: "establishing", cameraBias: "center", foregroundMask: "desk", notes: "Chalkboard is background; desks provide midground/foreground depth." }),
    cafe: profile({ location: "cafe", horizonY: 420, groundY: 805, floorContactY: 852, defaultShot: "table-shot", cameraBias: "center", foregroundMask: "cafe-table", notes: "Table foreground should partly frame dialogue shots." }),
    street: profile({ location: "street", horizonY: 520, groundY: 835, floorContactY: 884, defaultShot: "establishing", cameraBias: "center", foregroundMask: "none", notes: "Exterior shots place actors lower and smaller for street perspective." }),
    park: profile({ location: "park", horizonY: 470, groundY: 825, floorContactY: 874, defaultShot: "wide", cameraBias: "center", foregroundMask: "none", notes: "Outdoor compositions prefer wider spacing and smaller actor scale." }),
    "car-interior": profile({ location: "car-interior", horizonY: 390, groundY: 790, floorContactY: 835, defaultShot: "close-up", cameraBias: "center", foregroundMask: "car-dashboard", notes: "Dashboard foreground sells car interior scale; actors should not stand full-body here." }),
    "hospital-room": profile({ location: "hospital-room", horizonY: 430, groundY: 805, floorContactY: 850, defaultShot: "two-shot", cameraBias: "right", foregroundMask: "hospital-bed", notes: "Hospital bed frames the right side; actors stay left/center unless patient scene." }),
    airport: profile({ location: "airport", horizonY: 430, groundY: 820, floorContactY: 868, defaultShot: "establishing", cameraBias: "center", foregroundMask: "none", notes: "Terminal shots use wide spacing and smaller actor scale." }),
    shop: profile({ location: "shop", horizonY: 430, groundY: 808, floorContactY: 854, defaultShot: "two-shot", cameraBias: "center", foregroundMask: "shop-counter", notes: "Retail counter and shelves create foreground/midground separation." }),
    bathroom: profile({ location: "bathroom", horizonY: 420, groundY: 806, floorContactY: 850, defaultShot: "two-shot", cameraBias: "center", foregroundMask: "none", notes: "Mirror/sink are background anchors; keep character feet on tile floor." }),
    library: profile({ location: "library", horizonY: 415, groundY: 808, floorContactY: 852, defaultShot: "table-shot", cameraBias: "center", foregroundMask: "desk", notes: "Bookshelves should stay background; table frames dialogue." }),
    studio: profile({ location: "studio", horizonY: 430, groundY: 815, floorContactY: 860, defaultShot: "counter-shot", cameraBias: "center", foregroundMask: "desk", notes: "Studio plate is for meta/explainer inserts with strong lights and screen depth." }),
};

const LOCATION_ALIASES: Record<string, string> = {
    doorway: "hallway",
    corridor: "hallway",
    room: "living-room",
    home: "living-room",
    work: "office",
    workplace: "office",
    desk: "office",
    car: "car-interior",
    vehicle: "car-interior",
    commute: "car-interior",
    road: "street",
    outside: "street",
    store: "shop",
    shopping: "shop",
    clinic: "hospital-room",
    hospital: "hospital-room",
    terminal: "airport",
    plane: "airport",
    airplane: "airport",
};

export function normalizeSceneLocation(location?: string | null): string {
    const raw = String(location ?? "generic-room").toLowerCase().trim();
    return LOCATION_ALIASES[raw] ?? raw;
}

export function compositionProfileFor(background?: Pick<BackgroundSpec, "location"> | null): SceneCompositionProfile {
    const location = normalizeSceneLocation(background?.location);
    return SCENE_COMPOSITION_PROFILES[location] ?? DEFAULT_PROFILE;
}

function slotsFor(profile: SceneCompositionProfile, count: number): CharacterSlot[] {
    if (count <= 1) return profile.slots.solo;
    if (count === 2) return profile.slots.pair;
    return profile.slots.group;
}

function shotScaleMultiplier(shotType: SceneShotType): number {
    switch (shotType) {
        case "wide": return 0.9;
        case "close-up": return 1.08;
        case "prop-close-up": return 0.92;
        case "doorway-transition": return 0.96;
        case "counter-shot": return 1.02;
        case "table-shot": return 1.0;
        default: return 1;
    }
}

export function composeCharactersForScene(
    characters: CharacterProps[],
    background?: Pick<BackgroundSpec, "location"> | null,
    shotType: SceneShotType = "medium",
): CharacterProps[] {
    const profile = compositionProfileFor(background);
    const slots = slotsFor(profile, characters.length);
    const multiplier = shotScaleMultiplier(shotType);

    return characters.map((character, index) => {
        const slot = slots[index] ?? slots[slots.length - 1] ?? DEFAULT_PROFILE.slots.solo[0]!;
        const scale = Number.isFinite(character.scale) ? character.scale! : 1;
        return {
            ...character,
            x: slot.x,
            y: slot.y,
            scale: scale * slot.scale * multiplier,
            gazeTarget: character.gazeTarget ?? slot.gaze ?? "auto",
        };
    });
}

export function foregroundMaskForScene(background?: Pick<BackgroundSpec, "location"> | null): SceneCompositionProfile["foregroundMask"] {
    return compositionProfileFor(background).foregroundMask;
}
