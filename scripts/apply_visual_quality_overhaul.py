#!/usr/bin/env python3
from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def write(rel: str, text: str) -> None:
    path = ROOT / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


def sub_once(text: str, pattern: str, replacement: str, label: str, flags: int = 0) -> str:
    out, count = re.subn(pattern, replacement, text, count=1, flags=flags)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one regex match, found {count}")
    return out


# ---------------------------------------------------------------------------
# 1) Fix the production bridge. PR96 introduced these fields, but compose.js
#    dropped them before Remotion. This is the highest-leverage visual fix.
# ---------------------------------------------------------------------------
compose_rel = "long-compose/compose.js"
compose = read(compose_rel)
compose = replace_once(
    compose,
    '''        visualEvent: d.visualEvent,\n        speakerEmphasis: d.speakerEmphasis,\n''',
    '''        visualEvent: d.visualEvent,\n        speakerEmphasis: d.speakerEmphasis,\n        shotType: d.shotType || d.framing,\n        visualStyle: d.visualStyle || d.visual_style,\n        cinematic: d.cinematic,\n''',
    "forward cinematic cartoon props",
)

# Long-form speech should land near YouTube's normalised playback level. The
# previous -16 LUFS target measured ~-17.2 LUFS on the benchmark render.
compose = compose.replace("loudnorm=I=-16:TP=-1.5:LRA=11", "loudnorm=I=-14:TP=-1.0:LRA=9")
compose = compose.replace("// target - on true digital silence", "// -14 LUFS target - on true digital silence")

# Modern long-form captions: smaller phrases, lower safe-area position, less
# template-like shadow, and white body copy rather than tinting an entire turn.
compose = replace_once(
    compose,
    'Style: Caption,Inter Bold,62,&H00FFFFFF,&H0000DFFF,&H40000000,&H80000000,0,0,0,0,100,100,0,0,1,3,4,2,60,60,100,1',
    'Style: Caption,Inter Bold,50,&H00FFFFFF,&H0038D9FF,&H70000000,&H50000000,0,0,0,0,100,100,0,0,1,2,2,2,120,120,64,1',
    "caption house style",
)
compose = replace_once(compose, "const WORDS_PER_PHRASE = 8;", "const WORDS_PER_PHRASE = 6;", "caption phrase length")
compose = replace_once(
    compose,
    '''    const speakerName = typeof scene?.speaker_name === "string" ? scene.speaker_name.trim() : "";\n    const speakerColorTag = speakerName ? `{\\\\1c${hexToAssColor(scene.speaker_color)}}` : "";\n''',
    '''    const speakerName = typeof scene?.speaker_name === "string" ? scene.speaker_name.trim() : "";\n    const speakerColor = speakerName ? hexToAssColor(scene.speaker_color) : "";\n''',
    "caption speaker color scope",
)
compose = replace_once(
    compose,
    '''      let line = speakerColorTag;\n      if (speakerName && phraseStart === 0) {\n        line += `${escapeAssText(speakerName.toUpperCase())}: `;\n      }\n''',
    '''      let line = "";\n      if (speakerName && phraseStart === 0) {\n        line += `{\\\\fs30\\\\b1\\\\1c${speakerColor}}${escapeAssText(speakerName.toUpperCase())}  {\\\\rCaption}`;\n      }\n''',
    "caption speaker label",
)

# Convert the existing single-payoff sound design into cue-aware sound design
# using the already-vendored whoosh/impact/riser assets. This consumes the
# cinematic.sfxCue values that were previously metadata-only.
sfx_pattern = re.compile(
    r'''    // Sound design: NO per-cut SFX \(that whoosh-on-every-cut clashed with the\n'''
    r'''    // tone\)\. Instead, ONE tasteful accent at the payoff/reveal - a soft riser\+impact accent\.\n''',
)
# Historical comments changed across PRs, so replace the executable block by a
# more stable boundary rather than relying on prose.
compose = sub_once(
    compose,
    r'''    const sfxEvents = \[\];\n    const emphasisOffset = offsets\[emphasisIdx\];\n    if \(emphasisIdx >= 1 && emphasisOffset != null\) \{\n      if \(sfxAvailable\.riser\) sfxEvents\.push\(\{ type: "riser", time: Math\.max\(0, emphasisOffset - 1\.3\), volume: 0\.18 \}\);\n      if \(sfxAvailable\.impact\) sfxEvents\.push\(\{ type: "impact", time: emphasisOffset, volume: 0\.22 \}\);\n    \}\n''',
    '''    const sfxEvents = [];\n    const addSfx = (type, time, volume) => {\n      if (!sfxAvailable[type] || time == null || !Number.isFinite(time)) return;\n      // Avoid machine-gun duplicate cues on adjacent micro-scenes.\n      if (sfxEvents.some((event) => event.type === type && Math.abs(event.time - time) < 0.22)) return;\n      sfxEvents.push({ type, time: Math.max(0, time), volume });\n    };\n\n    scenes.forEach((scene, sceneIdx) => {\n      if (isOutroScene(scene)) return;\n      const cue = String(scene?.template_data?.cinematic?.sfxCue || "none").toLowerCase();\n      const at = offsets[sceneIdx];\n      if (at == null) return;\n      if (cue === "room-change") addSfx("whoosh", at, 0.10);\n      if (cue === "prop") addSfx("impact", at + 0.08, 0.075);\n      if (cue === "reaction" || cue === "soft-hit") addSfx("impact", at, 0.065);\n      if (cue === "payoff") {\n        addSfx("riser", at - 1.1, 0.12);\n        addSfx("impact", at, 0.14);\n      }\n    });\n\n    // Preserve a restrained payoff accent even when an older plan has no cue.\n    const emphasisOffset = offsets[emphasisIdx];\n    if (emphasisIdx >= 1 && emphasisOffset != null && !sfxEvents.some((event) => Math.abs(event.time - emphasisOffset) < 0.35)) {\n      addSfx("riser", emphasisOffset - 1.1, 0.10);\n      addSfx("impact", emphasisOffset, 0.13);\n    }\n''',
    "cue-aware SFX routing",
    flags=re.MULTILINE,
)
write(compose_rel, compose)


# ---------------------------------------------------------------------------
# 2) Wire acting metadata into pixels and tether hand-held props to actors.
# ---------------------------------------------------------------------------
scene_rel = "long-compose/remotion/src/compositions/CartoonScene.tsx"
scene = read(scene_rel)
scene = replace_once(
    scene,
    '''    cinematicCharacterLayerStyle,\n    cinematicOverlayStyle,\n''',
    '''    cinematicCharacterLayerStyle,\n    cinematicActingStageTransform,\n    actingPresetFor,\n    cinematicOverlayStyle,\n''',
    "import acting transform",
)

interaction_helpers = r'''
function propHolder(characters: CharacterProps[]): CharacterProps | undefined {
    return characters.find((character) => character.isSpeaking) ?? characters[0];
}

function actorRigPoint(character: CharacterProps, side: "left" | "right", raised: boolean): { x: number; y: number } {
    const scale = Number.isFinite(character.scale) ? character.scale! : 1;
    // Layered pilot rigs are 500x700 and scale from bottom-centre. These points
    // are the palm centres in the up/down arm SVGs, transformed into scene space.
    const rigX = side === "right" ? (raised ? 382 : 349) : (raised ? 118 : 151);
    const rigY = raised ? 222 : 535;
    return {
        x: character.x + 250 + (rigX - 250) * scale,
        y: character.y + 700 + (rigY - 700) * scale,
    };
}

function handHeldSide(character: CharacterProps): "left" | "right" {
    // In a two-shot, use the hand facing the conversation/prop focus. This keeps
    // the object between actors instead of outside the frame.
    return character.x < 720 ? "right" : "left";
}

function withPhysicalInteraction(
    characters: CharacterProps[],
    prop: ForegroundPropSpec | undefined,
    background: BackgroundSpec | undefined,
    cinematic: CinematicSceneSpec | undefined,
): CharacterProps[] {
    if (!prop?.type || prop.type === "none") return characters;
    if (propPlacementFor(background, prop, cinematic) !== "hand-held") return characters;
    const holder = propHolder(characters);
    if (!holder) return characters;
    const holderKey = holder.actorId ?? holder.characterId;
    const side = handHeldSide(holder);
    const preset = actingPresetFor(cinematic);
    return characters.map((character) => {
        const key = character.actorId ?? character.characterId;
        if (key !== holderKey) return character;
        const directedGesture = side === "right" ? "explain" : "point-left";
        return {
            ...character,
            gesture: directedGesture,
            gazeTarget: preset === "notices-prop" || preset === "payoff-freeze" ? "down" : character.gazeTarget,
            emphasis: character.emphasis === "none" ? "rim-glow" : character.emphasis,
        };
    });
}

function HandHeldPropOverlay({
    prop, characters, visualStyle, cinematic,
}: {
    prop?: ForegroundPropSpec;
    characters: CharacterProps[];
    visualStyle: ResolvedVisualStyle;
    cinematic?: CinematicSceneSpec;
}) {
    if (!prop?.type || prop.type === "none") return null;
    if (propPlacementFor(undefined, prop, cinematic) !== "hand-held") return null;
    const holder = propHolder(characters);
    if (!holder) return null;
    const side = handHeldSide(holder);
    const hand = actorRigPoint(holder, side, true);
    const recipe = normalizedShotRecipe(cinematic?.shotRecipe);
    const insert = recipe === "prop-insert";
    const directedProp: ForegroundPropSpec = { ...prop, placement: "hand-held", renderMode: "physical" };
    return (
        <div data-physical-interaction="actor-anchored-prop">
            <PropAsset
                prop={directedProp}
                x={insert ? 1000 : hand.x - 54}
                y={insert ? 342 : hand.y - 102}
                scale={(insert ? 1.22 : 0.64) * visualStyle.propScale}
                rotate={insert ? "-4deg" : (side === "right" ? "-10deg" : "10deg")}
                palette={visualStyle.palette}
                lineWeight={visualStyle.lineWeight}
                shadow={propShadow(visualStyle)}
                zIndex={8}
            />
        </div>
    );
}
'''
scene = replace_once(
    scene,
    '''const STYLE_PRESETS: Record<CartoonVisualStyleName, ResolvedVisualStyle> = {\n''',
    interaction_helpers + '''\nconst STYLE_PRESETS: Record<CartoonVisualStyleName, ResolvedVisualStyle> = {\n''',
    "physical interaction helpers",
)

# The ordinary overlay keeps wall/table/floor props. Hand-held props are now
# rendered inside the character stage so they share actor/camera motion.
scene = replace_once(
    scene,
    '''    const badge = shouldRenderPropAsBadge(prop, placement, cinematic);\n    const directedProp: ForegroundPropSpec = { ...prop, placement, renderMode: badge ? "badge" : "physical" };\n''',
    '''    if (placement === "hand-held") return null;\n    const badge = shouldRenderPropAsBadge(prop, placement, cinematic);\n    const directedProp: ForegroundPropSpec = { ...prop, placement, renderMode: badge ? "badge" : "physical" };\n''',
    "suppress world-space hand-held prop",
)
scene = replace_once(
    scene,
    '''    const directedCharacters = useMemo(\n        () => withConversationDirection(stagedCharacters, speakerEmphasis),\n        [stagedCharacters, speakerEmphasis],\n    );\n\n    const cinematicCamera = cinematicCameraStyle(cinematic, frame, durationInFrames);\n''',
    '''    const directedCharacters = useMemo(\n        () => withConversationDirection(stagedCharacters, speakerEmphasis),\n        [stagedCharacters, speakerEmphasis],\n    );\n    const performedCharacters = useMemo(\n        () => withPhysicalInteraction(directedCharacters, visualEvent?.foregroundProp, background, cinematic),\n        [directedCharacters, visualEvent?.foregroundProp, background, cinematic],\n    );\n\n    const cinematicCamera = cinematicCameraStyle(cinematic, frame, durationInFrames);\n''',
    "direct physical acting",
)
scene = replace_once(
    scene,
    '''    const characterLayer = cinematicCharacterLayerStyle(cinematic);\n    const recipe = normalizedShotRecipe(cinematic?.shotRecipe);\n''',
    '''    const characterLayer = cinematicCharacterLayerStyle(cinematic);\n    const actingStage = cinematicActingStageTransform(cinematic, frame);\n    const recipe = normalizedShotRecipe(cinematic?.shotRecipe);\n''',
    "compute acting stage transform",
)
scene = replace_once(
    scene,
    '''                        <AbsoluteFill style={{ transform: `translateX(${panX}px) ${characterLayerTransform(shotType)}`, ...characterLayer, zIndex: 5 }}>\n                            {directedCharacters.map((c, i) => <Character key={`${c.actorId ?? c.characterId}-${i}`} {...c} />)}\n                        </AbsoluteFill>\n''',
    '''                        <AbsoluteFill style={{ transform: combineTransforms(`translateX(${panX}px)`, characterLayerTransform(shotType), actingStage), ...characterLayer, zIndex: 5 }}>\n                            {performedCharacters.map((c, i) => <Character key={`${c.actorId ?? c.characterId}-${i}`} {...c} />)}\n                            <HandHeldPropOverlay prop={visualEvent?.foregroundProp} characters={performedCharacters} visualStyle={style} cinematic={cinematic} />\n                        </AbsoluteFill>\n''',
    "apply acting and actor-anchored props",
)
write(scene_rel, scene)


# ---------------------------------------------------------------------------
# 3) Make acting presets visually material rather than 1-2px metadata motion.
# ---------------------------------------------------------------------------
cin_rel = "long-compose/remotion/src/lib/cinematicDirection.ts"
cin = read(cin_rel)
cin = replace_once(
    cin,
    '''            return `translateX(${(-58 + entry * 58).toFixed(2)}px) translateY(${(Math.abs(beat) * -5).toFixed(2)}px)`;\n''',
    '''            return `translateX(${(-220 + entry * 220).toFixed(2)}px) translateY(${(Math.abs(beat) * -8).toFixed(2)}px) rotate(${(beat * 0.45).toFixed(2)}deg)`;\n''',
    "walk-cross performance",
)
cin = replace_once(
    cin,
    '''            return `translateX(${(frame < 8 ? -4 + frame : slow * 2).toFixed(2)}px) rotate(${(slow * 0.35).toFixed(2)}deg)`;\n''',
    '''            return `translateX(${(frame < 8 ? -16 + frame * 2 : slow * 4).toFixed(2)}px) rotate(${(frame < 8 ? -1.8 + frame * 0.28 : slow * 0.55).toFixed(2)}deg)`;\n''',
    "double-take performance",
)
cin = replace_once(
    cin,
    '''            return `translateY(${(Math.min(frame, 12) / 12 * -7).toFixed(2)}px)`;\n''',
    '''            return `translateY(${(Math.min(frame, 12) / 12 * -12).toFixed(2)}px) scale(${(1 + Math.min(frame, 12) / 12 * 0.018).toFixed(3)})`;\n''',
    "notice-prop performance",
)
write(cin_rel, cin)


# ---------------------------------------------------------------------------
# 4) Give characters better contact/depth. Existing SVG rig stays compatible.
# ---------------------------------------------------------------------------
character_rel = "long-compose/remotion/src/components/Character.tsx"
character = read(character_rel)
character = replace_once(
    character,
    '''            <Img src={rig("body.svg")} style={layerStyle} />\n''',
    '''            <div style={{\n                position: "absolute", left: 126, bottom: 6, width: 248, height: 36,\n                borderRadius: "50%", background: "rgba(15,23,42,0.18)", filter: "blur(9px)",\n                transform: `scaleX(${0.92 + Math.abs(breathWave) * 0.04})`, transformOrigin: "center", zIndex: -1,\n            }} />\n            <Img src={rig("body.svg")} style={{ ...layerStyle, filter: "drop-shadow(0 10px 10px rgba(15,23,42,0.10))" }} />\n''',
    "character contact/depth",
)
write(character_rel, character)


# ---------------------------------------------------------------------------
# 5) Replace the central charger icon with a self-authored physical prop.
# ---------------------------------------------------------------------------
charger_svg = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
  <defs>
    <linearGradient id="phone" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#334155"/><stop offset="1" stop-color="#0F172A"/></linearGradient>
    <linearGradient id="brick" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#FFFFFF"/><stop offset="1" stop-color="#E2E8F0"/></linearGradient>
  </defs>
  <path d="M126 170 C126 207 172 203 172 231 C172 245 161 250 149 250" fill="none" stroke="#334155" stroke-width="9" stroke-linecap="round"/>
  <rect x="72" y="28" width="88" height="148" rx="18" fill="url(#phone)" stroke="#111827" stroke-width="8"/>
  <rect x="82" y="45" width="68" height="104" rx="10" fill="#93C5FD"/>
  <circle cx="116" cy="161" r="6" fill="#CBD5E1"/>
  <path d="M111 177 v18" stroke="#334155" stroke-width="9" stroke-linecap="round"/>
  <rect x="95" y="190" width="46" height="48" rx="10" fill="url(#brick)" stroke="#334155" stroke-width="7"/>
  <path d="M106 238 v13 M130 238 v13" stroke="#475569" stroke-width="7" stroke-linecap="round"/>
  <path d="M119 201 l-8 14 h10 l-5 13 17-19 h-10 l5-8z" fill="#F59E0B"/>
</svg>\n'''
write("long-compose/remotion/public/assets/props/physical/phone-charger.svg", charger_svg)

registry_rel = "long-compose/remotion/src/lib/assetRegistry.ts"
registry = read(registry_rel)
registry = replace_once(
    registry,
    '''const scenePlate = (location: string, tags: string[]): RegisteredAsset => ({\n''',
    '''const internalProp = (key: string, filename: string, tags: string[]): RegisteredAsset => ({\n    key, role: "prop", tags: [...tags, "physical", "object"], width: 256, height: 256,\n    compositeMode: "overlay", status: "starter-local",\n    source: { kind: "local-svg", library: "internal", path: `assets/props/physical/${filename}.svg`, license: MIT },\n});\n\nconst scenePlate = (location: string, tags: string[]): RegisteredAsset => ({\n''',
    "internal physical prop helper",
)
registry = replace_once(
    registry,
    '''    "prop:phone-charger:mdi": mdiProp("prop:phone-charger:mdi", "phone-charger", ["phone", "charger", "cellphone", "cable"], "cellphone-charging"),\n''',
    '''    "prop:phone-charger:physical": internalProp("prop:phone-charger:physical", "phone-charger", ["phone", "charger", "cellphone", "cable", "hand-held"]),\n''',
    "physical charger registry",
)
registry = registry.replace('"prop:phone-charger:mdi"', '"prop:phone-charger:physical"')
write(registry_rel, registry)


# ---------------------------------------------------------------------------
# 6) Expand environmental art direction for locations that previously all
#    received the same generic rug/art/lamp dressing.
# ---------------------------------------------------------------------------
dressing_rel = "long-compose/remotion/src/components/SceneDressing.tsx"
dressing = read(dressing_rel)
extended = r'''
function ExtendedLocationDressing({ location, frame }: { location: string; frame: number }) {
  const pulse = 0.5 + Math.sin(frame / 42) * 0.5;
  if (location === "bedroom") return <><div style={{ position:"absolute", right:100, bottom:88, width:430, height:150, borderRadius:"38px 38px 20px 20px", background:"linear-gradient(180deg,#BFDBFE,#93C5FD)", boxShadow:"0 22px 50px rgba(15,23,42,.16)" }} /><div style={{ position:"absolute", right:390, bottom:215, width:115, height:60, borderRadius:24, background:"rgba(255,255,255,.9)" }} /><PracticalLight frame={frame} left={120} top={110}/></>;
  if (location === "cafe") return <><TableDepth y={590}/><div style={{position:"absolute",left:110,top:70,width:190,height:120,borderRadius:20,background:"#422006",border:"8px solid rgba(255,255,255,.45)"}}/><div style={{position:"absolute",right:120,top:40,width:34,height:160,background:"rgba(71,85,105,.28)"}}/><div style={{position:"absolute",right:93,top:180,width:88,height:50,borderRadius:"50%",background:`rgba(253,224,71,${.45+pulse*.2})`,filter:"blur(5px)"}}/></>;
  if (location === "classroom") return <><div style={{position:"absolute",left:115,top:70,width:560,height:260,borderRadius:18,background:"#14532D",border:"12px solid #78350F",boxShadow:"0 18px 42px rgba(15,23,42,.16)"}}/><div style={{position:"absolute",left:190,right:170,bottom:80,height:95,borderRadius:"28px 28px 10px 10px",background:"linear-gradient(180deg,#D6D3D1,#A8A29E)"}}/></>;
  if (location === "library") return <><Shelf left={70} top={72} w={350}/><Shelf left={820} top={92} w={350}/><TableDepth y={585}/><div style={{position:"absolute",left:30,right:30,top:220,height:9,background:"rgba(120,53,15,.26)"}}/></>;
  if (location === "airport") return <><div style={{position:"absolute",left:70,right:70,top:60,height:320,borderRadius:30,background:"linear-gradient(180deg,rgba(186,230,253,.58),rgba(224,242,254,.22))",border:"10px solid rgba(255,255,255,.52)"}}/><div style={{position:"absolute",left:630,top:85,width:300,height:82,borderRadius:16,background:"#1E3A8A",color:"white",fontSize:30,fontWeight:800,display:"flex",alignItems:"center",justifyContent:"center",letterSpacing:2}}>GATES  A · B</div><div style={{position:"absolute",right:180,bottom:105,width:100,height:72,borderRadius:18,background:"#F97316",boxShadow:"0 18px 28px rgba(15,23,42,.16)"}}/></>;
  if (location === "shop") return <><Shelf left={70} top={90} w={390}/><Shelf left={760} top={90} w={390}/><div style={{position:"absolute",left:0,right:0,bottom:50,height:110,background:"linear-gradient(180deg,#FDE68A,#F59E0B)",borderTop:"8px solid rgba(15,23,42,.16)"}}/></>;
  if (location === "bathroom") return <><div style={{position:"absolute",left:100,top:72,width:320,height:260,borderRadius:30,background:"linear-gradient(135deg,#DBEAFE,#F8FAFC)",border:"12px solid rgba(148,163,184,.45)",boxShadow:`0 0 ${18+pulse*16}px rgba(186,230,253,.35)`}}/><div style={{position:"absolute",left:150,bottom:135,width:300,height:76,borderRadius:"50% 50% 24px 24px",background:"#F8FAFC",border:"8px solid rgba(100,116,139,.24)"}}/></>;
  if (location === "hospital-room") return <><div style={{position:"absolute",right:110,bottom:105,width:470,height:120,borderRadius:"34px 34px 18px 18px",background:"linear-gradient(180deg,#DBEAFE,#BFDBFE)",border:"8px solid rgba(30,64,175,.22)"}}/><div style={{position:"absolute",right:165,top:90,width:160,height:110,borderRadius:20,background:"#F8FAFC",border:"7px solid rgba(100,116,139,.28)"}}/><div style={{position:"absolute",right:185,top:135,width:120,height:6,background:"#22C55E",boxShadow:`0 0 ${8+pulse*8}px rgba(34,197,94,.45)`}}/></>;
  if (location === "studio") return <><div style={{position:"absolute",left:120,top:70,width:320,height:190,borderRadius:24,background:"linear-gradient(135deg,#1E293B,#334155)",border:"9px solid #64748B",boxShadow:"0 0 55px rgba(56,189,248,.2)"}}/><div style={{position:"absolute",right:120,top:80,width:90,height:260,transform:"rotate(18deg)",background:"linear-gradient(180deg,rgba(253,224,71,.32),transparent)",clipPath:"polygon(35% 0,65% 0,100% 100%,0 100%)"}}/><TableDepth y={610}/></>;
  if (location === "car-interior") return <><div style={{position:"absolute",left:80,right:80,top:60,height:360,borderRadius:"48% 48% 20% 20%",background:"linear-gradient(180deg,rgba(186,230,253,.68),rgba(148,163,184,.24))",border:"12px solid rgba(30,41,59,.5)"}}/><div style={{position:"absolute",left:0,right:0,bottom:0,height:185,borderRadius:"50% 50% 0 0",background:"linear-gradient(180deg,#334155,#0F172A)"}}/></>;
  if (location === "park") return <><div style={{position:"absolute",left:85,bottom:100,width:380,height:96,borderRadius:"18px 18px 10px 10px",background:"#92400E",boxShadow:"0 18px 32px rgba(15,23,42,.14)"}}/><div style={{position:"absolute",right:100,top:65,width:150,height:150,borderRadius:"50%",background:"rgba(34,197,94,.38)",filter:"blur(2px)"}}/></>;
  return <GenericDressing frame={frame}/>;
}
'''
dressing = replace_once(
    dressing,
    '''export function SceneDressing({ background, frame }: SceneDressingProps) {\n''',
    extended + '''\nexport function SceneDressing({ background, frame }: SceneDressingProps) {\n''',
    "extended environment dressing",
)
dressing = replace_once(
    dressing,
    '''      {(location === "street" || location === "park") && <StreetDressing frame={frame} />}\n      {!location || !["kitchen", "living-room", "office", "hallway", "school-hallway", "street", "park"].includes(location) ? <GenericDressing frame={frame} /> : null}\n''',
    '''      {location === "street" && <StreetDressing frame={frame} />}\n      {location && !["kitchen", "living-room", "office", "hallway", "school-hallway", "street"].includes(location) ? <ExtendedLocationDressing location={location} frame={frame} /> : null}\n      {!location ? <GenericDressing frame={frame} /> : null}\n''',
    "route location-specific dressing",
)
write(dressing_rel, dressing)


# ---------------------------------------------------------------------------
# 7) Version the planner prompt instead of mutating v12 in place.
# ---------------------------------------------------------------------------
prompt12 = read("engine/prompts/cartoon_visual_planner/12.md")
appendix = r'''

## Pixel-level physicality (v13)

Treat renderer-visible physicality as part of correctness, not optional polish.

- A hand-held central prop must be held by a character in the shot. Do not plan a floating icon, badge, or card for a physical object.
- For `charger`, `phone`, `keys`, `coffee`, `document`, or another carried object, pair the prop with a compatible gesture and gaze. The actor should visibly notice, hold, carry, present, place, or use it.
- `prop-insert` is an object close-up, not a UI card. Use it when the object's physical state matters.
- The payoff should contain a visible changed behavior or object interaction whenever the story supports one. Prefer `Host grabs/carries/connects/places X` over `X is visible`.
- Across adjacent scenes, vary composition in ways a viewer can perceive: subject scale, screen position, foreground occlusion, reaction focus, prop insertion, or environment depth. Merely changing metadata while keeping the same centred two-shot is not variety.
- Reserve `ui-badge` semantics for literal interfaces, scores, notifications, or abstract overlays. Narrative objects are physical by default.

Before output, imagine the rendered pixels. If a scene would still read as "two puppets + floating icon + caption", revise the framing/action so the scene contains an actual visual beat.
'''
if "## Pixel-level physicality (v13)" not in prompt12:
    write("engine/prompts/cartoon_visual_planner/13.md", prompt12.rstrip() + appendix + "\n")
agent_rel = "engine/agents/cartoon_visual_planner.json"
agent = json.loads(read(agent_rel))
agent["version"] = "13"
agent["prompt"] = "cartoon_visual_planner@13"
write(agent_rel, json.dumps(agent, indent=2) + "\n")


# ---------------------------------------------------------------------------
# 8) Regression tests: test the bridge and pixel-producing contracts, not just
#    schema presence.
# ---------------------------------------------------------------------------
test = r'''const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const compose = fs.readFileSync(path.join(root, "compose.js"), "utf8");
const scene = fs.readFileSync(path.join(root, "remotion/src/compositions/CartoonScene.tsx"), "utf8");
const direction = fs.readFileSync(path.join(root, "remotion/src/lib/cinematicDirection.ts"), "utf8");
const registry = fs.readFileSync(path.join(root, "remotion/src/lib/assetRegistry.ts"), "utf8");
const dressing = fs.readFileSync(path.join(root, "remotion/src/components/SceneDressing.tsx"), "utf8");

test("production bridge forwards all cinematic direction into Remotion", () => {
  for (const token of ["shotType: d.shotType || d.framing", "visualStyle: d.visualStyle || d.visual_style", "cinematic: d.cinematic"]) {
    assert.match(compose, new RegExp(token.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")));
  }
});

test("acting presets and carried props materially affect rendered pixels", () => {
  assert.match(scene, /cinematicActingStageTransform\(cinematic, frame\)/);
  assert.match(scene, /data-physical-interaction="actor-anchored-prop"/);
  assert.match(scene, /actorRigPoint/);
  assert.match(scene, /withPhysicalInteraction/);
  assert.match(direction, /-220 \+ entry \* 220/);
});

test("central charger is a physical self-authored object, not the MDI icon card", () => {
  assert.match(registry, /prop:phone-charger:physical/);
  assert.doesNotMatch(registry, /prop:phone-charger:mdi/);
  assert.ok(fs.existsSync(path.join(root, "remotion/public/assets/props/physical/phone-charger.svg")));
});

test("long-form captions and sound design are production-routed", () => {
  assert.match(compose, /const WORDS_PER_PHRASE = 6/);
  assert.match(compose, /Inter Bold,50/);
  assert.match(compose, /template_data\?\.cinematic\?\.sfxCue/);
  assert.match(compose, /loudnorm=I=-14:TP=-1\.0:LRA=9/);
});

test("formerly generic environments now have location-specific dressing", () => {
  for (const location of ["bedroom", "cafe", "classroom", "library", "airport", "shop", "bathroom", "hospital-room", "studio", "car-interior", "park"]) {
    assert.match(dressing, new RegExp(`location === \\"${location}\\"`));
  }
});
'''
write("long-compose/tests/integrated-visual-quality.test.js", test)

print("Integrated visual-quality transformation applied successfully.")
