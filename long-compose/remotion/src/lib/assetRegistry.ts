export type AssetSourceKind = "local-svg" | "local-lottie" | "remotion-component";
export type AssetLibrary = "internal" | "iconify" | "open-peeps" | "lottie" | "remotion-bits" | "scene-pack";

export interface AssetLicense {
    name: string;
    attributionRequired: boolean;
    url?: string;
}

export interface AssetSource {
    kind: AssetSourceKind;
    library: AssetLibrary;
    path?: string;
    component?: string;
    license: AssetLicense;
    sourceUrl?: string;
}

export interface RegisteredAsset {
    key: string;
    role: "scenePlate" | "prop" | "setPiece" | "characterPart" | "motionPreset";
    tags: string[];
    source: AssetSource;
    width?: number;
    height?: number;
    compositeMode?: "replace-background" | "overlay";
    status?: "starter-local" | "placeholder-local" | "placeholder-empty" | "component-contract" | "vendored-third-party";
}

export interface BackgroundLookup {
    location?: string;
    variant?: string;
}

const CC0: AssetLicense = { name: "CC0-1.0", attributionRequired: false, url: "https://creativecommons.org/publicdomain/zero/1.0/" };
const MIT: AssetLicense = { name: "MIT", attributionRequired: false };
const APACHE_2: AssetLicense = { name: "Apache-2.0", attributionRequired: false };

const mdi = (name: string): AssetSource => ({
    kind: "local-svg",
    library: "iconify",
    path: `assets/props/iconify/${name}.svg`,
    license: APACHE_2,
    sourceUrl: `https://github.com/Templarian/MaterialDesign/blob/master/svg/${name}.svg`,
});

const internalProp = (key: string, filename: string, tags: string[]): RegisteredAsset => ({
    key, role: "prop", tags: [...tags, "physical", "object"], width: 256, height: 256,
    compositeMode: "overlay", status: "starter-local",
    source: { kind: "local-svg", library: "internal", path: `assets/props/physical/${filename}.svg`, license: MIT },
});

const scenePlate = (location: string, tags: string[]): RegisteredAsset => ({
    key: `scene:${location}:default`,
    role: "scenePlate",
    tags: [...tags, location, "scene", "plate", "complete-background"],
    width: 1920,
    height: 1080,
    compositeMode: "replace-background",
    status: "starter-local",
    source: { kind: "local-svg", library: "scene-pack", path: `assets/scene-plates/${location}/default.svg`, license: CC0 },
});

const mdiProp = (key: string, filename: string, tags: string[], sourceName = filename): RegisteredAsset => ({
    key,
    role: "prop",
    tags: [...tags, "mdi", "iconify", "vendored", "object"],
    width: 256,
    height: 256,
    compositeMode: "overlay",
    status: "vendored-third-party",
    source: { ...mdi(filename), sourceUrl: `https://github.com/Templarian/MaterialDesign/blob/master/svg/${sourceName}.svg` },
});

export const LOCAL_ASSET_REGISTRY: Record<string, RegisteredAsset> = {
    "scene:office:default": scenePlate("office", ["desk", "screen", "work", "room", "professional"]),
    "scene:kitchen:default": scenePlate("kitchen", ["counter", "morning", "home", "room", "daily-life"]),
    "scene:living-room:default": scenePlate("living-room", ["sofa", "home", "room", "conversation"]),
    "scene:hallway:default": scenePlate("hallway", ["doorway", "transition", "corridor", "room-change"]),
    "scene:bedroom:default": scenePlate("bedroom", ["bed", "sleep", "home", "night", "room"]),
    "scene:classroom:default": scenePlate("classroom", ["school", "chalkboard", "desks", "learning"]),
    "scene:cafe:default": scenePlate("cafe", ["coffee", "table", "shop", "conversation"]),
    "scene:street:default": scenePlate("street", ["outdoor", "road", "city", "commute"]),
    "scene:park:default": scenePlate("park", ["outdoor", "trees", "bench", "nature"]),
    "scene:car-interior:default": scenePlate("car-interior", ["car", "vehicle", "dashboard", "commute"]),
    "scene:hospital-room:default": scenePlate("hospital-room", ["hospital", "clinic", "bed", "medical"]),
    "scene:airport:default": scenePlate("airport", ["terminal", "travel", "glass", "luggage"]),
    "scene:shop:default": scenePlate("shop", ["store", "shelves", "counter", "retail"]),
    "scene:bathroom:default": scenePlate("bathroom", ["mirror", "sink", "tile", "home"]),
    "scene:library:default": scenePlate("library", ["books", "study", "table", "quiet"]),
    "scene:studio:default": scenePlate("studio", ["lights", "screen", "explainer", "meta"]),

    "setpiece:doorway:local": {
        key: "setpiece:doorway:local",
        role: "setPiece",
        tags: ["doorway", "door", "transition"],
        width: 420,
        height: 620,
        compositeMode: "overlay",
        status: "starter-local",
        source: { kind: "local-svg", library: "scene-pack", path: "assets/set-pieces/doorway.svg", license: CC0 },
    },

    "prop:phone-charger:physical": internalProp("prop:phone-charger:physical", "phone-charger", ["phone", "charger", "cellphone", "cable", "hand-held"]),
    "prop:keys:mdi": mdiProp("prop:keys:mdi", "keys", ["key", "keys", "lock"], "key-variant"),
    "prop:laptop:mdi": mdiProp("prop:laptop:mdi", "laptop", ["computer", "screen", "work"]),
    "prop:calendar:mdi": mdiProp("prop:calendar:mdi", "calendar", ["date", "schedule", "time"]),
    "prop:clock:mdi": mdiProp("prop:clock:mdi", "clock", ["clock", "alarm", "time"], "clock-outline"),
    "prop:coffee:mdi": mdiProp("prop:coffee:mdi", "coffee", ["coffee", "mug", "drink"]),
    "prop:document:mdi": mdiProp("prop:document:mdi", "document", ["document", "paper", "letter", "bill", "file"], "file-document-outline"),
    "prop:map:mdi": mdiProp("prop:map:mdi", "map", ["map", "route", "navigation"], "map-outline"),
    "prop:bed:mdi": mdiProp("prop:bed:mdi", "bed", ["bed", "sheets", "sleep"]),
    "prop:car:mdi": mdiProp("prop:car:mdi", "car", ["car", "vehicle", "commute"]),
    "prop:kettle:mdi": mdiProp("prop:kettle:mdi", "kettle", ["kettle", "boil", "steam"]),
    "prop:food:mdi": mdiProp("prop:food:mdi", "food", ["food", "meal", "plate"]),
    "prop:shoes:mdi": mdiProp("prop:shoes:mdi", "shoes", ["shoe", "shoes", "sneaker"], "shoe-sneaker"),
    "prop:window:mdi": mdiProp("prop:window:mdi", "window", ["window", "light", "room"], "window-open"),
    "prop:door:mdi": mdiProp("prop:door:mdi", "door", ["door", "doorway", "open"], "door-open"),
    "prop:tool:mdi": mdiProp("prop:tool:mdi", "tool", ["tool", "tools", "repair"], "tools"),
    "prop:appliance:mdi": mdiProp("prop:appliance:mdi", "appliance", ["appliance", "device", "machine"], "washing-machine"),

    "character:reaction-open-peeps": {
        key: "character:reaction-open-peeps",
        role: "characterPart",
        tags: ["reaction", "face", "person", "open-peeps"],
        source: { kind: "local-svg", library: "open-peeps", path: "assets/characters/open-peeps/reaction-head.svg", license: CC0 },
        status: "placeholder-local",
    },
    "motion:reaction-pop:remotion-bits": {
        key: "motion:reaction-pop:remotion-bits",
        role: "motionPreset",
        tags: ["reaction-pop", "particle", "motion"],
        source: { kind: "remotion-component", library: "remotion-bits", component: "reaction-pop", license: MIT },
        status: "component-contract",
    },
    "motion:attention-pulse:lottie": {
        key: "motion:attention-pulse:lottie",
        role: "motionPreset",
        tags: ["pulse", "attention", "lottie"],
        source: { kind: "local-lottie", library: "lottie", path: "assets/motion/lottie/attention-pulse.json", license: MIT },
        status: "placeholder-empty",
    },
};

const SCENE_PLATE_BY_LOCATION: Record<string, string> = {
    office: "scene:office:default",
    work: "scene:office:default",
    workplace: "scene:office:default",
    desk: "scene:office:default",
    kitchen: "scene:kitchen:default",
    "living-room": "scene:living-room:default",
    home: "scene:living-room:default",
    room: "scene:living-room:default",
    hallway: "scene:hallway:default",
    doorway: "scene:hallway:default",
    corridor: "scene:hallway:default",
    bedroom: "scene:bedroom:default",
    sleep: "scene:bedroom:default",
    classroom: "scene:classroom:default",
    school: "scene:classroom:default",
    cafe: "scene:cafe:default",
    coffee: "scene:cafe:default",
    street: "scene:street:default",
    road: "scene:street:default",
    outside: "scene:street:default",
    park: "scene:park:default",
    "car-interior": "scene:car-interior:default",
    car: "scene:car-interior:default",
    vehicle: "scene:car-interior:default",
    commute: "scene:car-interior:default",
    "hospital-room": "scene:hospital-room:default",
    hospital: "scene:hospital-room:default",
    clinic: "scene:hospital-room:default",
    airport: "scene:airport:default",
    terminal: "scene:airport:default",
    airplane: "scene:airport:default",
    shop: "scene:shop:default",
    store: "scene:shop:default",
    shopping: "scene:shop:default",
    bathroom: "scene:bathroom:default",
    library: "scene:library:default",
    study: "scene:library:default",
    studio: "scene:studio:default",
};

const SET_PIECE_BY_KIND: Record<string, string> = {
    doorway: "setpiece:doorway:local",
};

const PROP_ASSET_BY_TYPE: Record<string, string> = {
    phone: "prop:phone-charger:physical",
    cellphone: "prop:phone-charger:physical",
    charger: "prop:phone-charger:physical",
    "phone-charger": "prop:phone-charger:physical",
    keys: "prop:keys:mdi",
    key: "prop:keys:mdi",
    laptop: "prop:laptop:mdi",
    computer: "prop:laptop:mdi",
    calendar: "prop:calendar:mdi",
    clock: "prop:clock:mdi",
    "alarm clock": "prop:clock:mdi",
    coffee: "prop:coffee:mdi",
    mug: "prop:coffee:mdi",
    document: "prop:document:mdi",
    letter: "prop:document:mdi",
    bill: "prop:document:mdi",
    file: "prop:document:mdi",
    "route-map": "prop:map:mdi",
    map: "prop:map:mdi",
    bed: "prop:bed:mdi",
    sheets: "prop:bed:mdi",
    car: "prop:car:mdi",
    vehicle: "prop:car:mdi",
    kettle: "prop:kettle:mdi",
    food: "prop:food:mdi",
    shoes: "prop:shoes:mdi",
    shoe: "prop:shoes:mdi",
    window: "prop:window:mdi",
    door: "prop:door:mdi",
    doorway: "prop:door:mdi",
    tool: "prop:tool:mdi",
    tools: "prop:tool:mdi",
    appliance: "prop:appliance:mdi",
    device: "prop:appliance:mdi",
};

export function assetByKey(key?: string | null): RegisteredAsset | undefined {
    if (!key) return undefined;
    return LOCAL_ASSET_REGISTRY[key];
}

export function resolveScenePlate(background: BackgroundLookup): RegisteredAsset | undefined {
    const location = String(background.location ?? "").toLowerCase();
    const variant = String(background.variant ?? "default").toLowerCase();
    const exact = assetByKey(`scene:${location}:${variant}`);
    if (exact?.role === "scenePlate") return exact;
    const fallback = assetByKey(SCENE_PLATE_BY_LOCATION[location]);
    return fallback?.role === "scenePlate" ? fallback : undefined;
}

export function resolveSetPieceAsset(kind?: string): RegisteredAsset | undefined {
    const key = SET_PIECE_BY_KIND[String(kind ?? "").toLowerCase()];
    const asset = assetByKey(key);
    return asset?.role === "setPiece" ? asset : undefined;
}

export function resolvePropAsset(propType?: string): RegisteredAsset | undefined {
    const normalized = String(propType ?? "").toLowerCase().trim();
    const key = PROP_ASSET_BY_TYPE[normalized];
    const asset = assetByKey(key);
    return asset?.role === "prop" ? asset : undefined;
}

export function renderableLocalAsset(asset?: RegisteredAsset): asset is RegisteredAsset & { source: AssetSource & { path: string } } {
    return Boolean(asset?.source.path && (asset.source.kind === "local-svg" || asset.source.kind === "local-lottie"));
}

export function assetLicenseSummary(): Array<{ key: string; library: AssetLibrary; license: string; local: boolean; status?: RegisteredAsset["status"] }> {
    return Object.values(LOCAL_ASSET_REGISTRY).map((asset) => ({
        key: asset.key,
        library: asset.source.library,
        license: asset.source.license.name,
        local: Boolean(asset.source.path),
        status: asset.status,
    }));
}
