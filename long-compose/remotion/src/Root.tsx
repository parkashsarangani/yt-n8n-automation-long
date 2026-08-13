import { Composition } from "remotion";

// Existing compositions
import { StatReveal } from "./compositions/StatReveal";
import { Comparison } from "./compositions/Comparison";
import { KineticText } from "./compositions/KineticText";
import { CaptionOverlay } from "./compositions/CaptionOverlay";
import { SceneTransition } from "./compositions/SceneTransition";

// Library: List Animations (12)
import { ListAsymmetric3 } from "./scenes/ListAnimations/ListAsymmetric3";
import { ListNumberedVertical } from "./scenes/ListAnimations/ListNumberedVertical";
import { ListStaggered } from "./scenes/ListAnimations/ListStaggered";
import { ListFullscreenSequence } from "./scenes/ListAnimations/ListFullscreenSequence";
import { ListMinimalLeft } from "./scenes/ListAnimations/ListMinimalLeft";
import { ListStatsFocused } from "./scenes/ListAnimations/ListStatsFocused";
import { ListTimeline } from "./scenes/ListAnimations/ListTimeline";
import { ListUnevenGrid } from "./scenes/ListAnimations/ListUnevenGrid";
import { ListTwoColumnCompare } from "./scenes/ListAnimations/ListTwoColumnCompare";
import { ListSimpleText } from "./scenes/ListAnimations/ListSimpleText";
import { ListHorizontalPeek } from "./scenes/ListAnimations/ListHorizontalPeek";
import { ListHeroWithList } from "./scenes/ListAnimations/ListHeroWithList";

// Library: Data Animations (8)
import { DataBarChart } from "./scenes/DataAnimations/DataBarChart";
import { DataLineChart } from "./scenes/DataAnimations/DataLineChart";
import { DataPieChart } from "./scenes/DataAnimations/DataPieChart";
import { DataStatsCards } from "./scenes/DataAnimations/DataStatsCards";
import { DataProgressBars } from "./scenes/DataAnimations/DataProgressBars";
import { DataTimeline } from "./scenes/DataAnimations/DataTimeline";
import { DataRanking } from "./scenes/DataAnimations/DataRanking";
import { DataGauge } from "./scenes/DataAnimations/DataGauge";

// Library: Text Animations (12)
import { TextKinetic } from "./scenes/TextAnimations/TextKinetic";
import { TextScramble } from "./scenes/TextAnimations/TextScramble";
import { TextWave } from "./scenes/TextAnimations/TextWave";
import { TextSplit } from "./scenes/TextAnimations/TextSplit";
import { TextMaskReveal } from "./scenes/TextAnimations/TextMaskReveal";
import { TextGlitch } from "./scenes/TextAnimations/TextGlitch";
import { TextNeon } from "./scenes/TextAnimations/TextNeon";
import { Text3DFlip } from "./scenes/TextAnimations/Text3DFlip";
import { TextTypewriter } from "./scenes/TextAnimations/TextTypewriter";
import { TextCounter } from "./scenes/TextAnimations/TextCounter";
import { TextGradient } from "./scenes/TextAnimations/TextGradient";
import { TextExplode } from "./scenes/TextAnimations/TextExplode";

// Library: Roller Animations (22)
import { RollerSlotMachine } from "./scenes/RollerAnimations/RollerSlotMachine";
import { RollerFlip } from "./scenes/RollerAnimations/RollerFlip";
import { RollerFadeSlide } from "./scenes/RollerAnimations/RollerFadeSlide";
import { RollerBlur } from "./scenes/RollerAnimations/RollerBlur";
import { RollerScaleBounce } from "./scenes/RollerAnimations/RollerScaleBounce";
import { RollerGlitch } from "./scenes/RollerAnimations/RollerGlitch";
import { RollerWave } from "./scenes/RollerAnimations/RollerWave";
import { RollerTypewriter } from "./scenes/RollerAnimations/RollerTypewriter";
import { RollerLiquid } from "./scenes/RollerAnimations/RollerLiquid";
import { RollerVerticalList } from "./scenes/RollerAnimations/RollerVerticalList";
import { RollerDrum } from "./scenes/RollerAnimations/RollerDrum";
import { RollerMaskSlide } from "./scenes/RollerAnimations/RollerMaskSlide";
import { RollerSlotReveal } from "./scenes/RollerAnimations/RollerSlotReveal";
import { RollerDramaticStop } from "./scenes/RollerAnimations/RollerDramaticStop";
import { RollerMultiSlot } from "./scenes/RollerAnimations/RollerMultiSlot";
import { RollerCountdown } from "./scenes/RollerAnimations/RollerCountdown";
import { RollerOutlineHighlight } from "./scenes/RollerAnimations/RollerOutlineHighlight";
import { RollerPerspectiveStripes } from "./scenes/RollerAnimations/RollerPerspectiveStripes";
import { RollerShuffle } from "./scenes/RollerAnimations/RollerShuffle";
import { Roller3DCarousel } from "./scenes/RollerAnimations/Roller3DCarousel";
import { RollerSplitFlap } from "./scenes/RollerAnimations/RollerSplitFlap";
import { RollerGradientWave } from "./scenes/RollerAnimations/RollerGradientWave";

// Library: Cinematic Animations (10)
import { CinematicEpic } from "./scenes/CinematicAnimations/CinematicEpic";
import { CinematicHorror } from "./scenes/CinematicAnimations/CinematicHorror";
import { CinematicRomance } from "./scenes/CinematicAnimations/CinematicRomance";
import { CinematicAction } from "./scenes/CinematicAnimations/CinematicAction";
import { CinematicDocumentary } from "./scenes/CinematicAnimations/CinematicDocumentary";
import { CinematicSciFi } from "./scenes/CinematicAnimations/CinematicSciFi";
import { CinematicNoir } from "./scenes/CinematicAnimations/CinematicNoir";
import { CinematicAnime } from "./scenes/CinematicAnimations/CinematicAnime";
import { CinematicVintage } from "./scenes/CinematicAnimations/CinematicVintage";
import { CinematicMinimalEnd } from "./scenes/CinematicAnimations/CinematicMinimalEnd";

const FPS = 30;
const W = 1080;
const H = 1920;
const D = 120; // default frames

// Helper to reduce boilerplate
const S = (id: string, component: React.FC<any>, dur = D) => (
    <Composition key={id} id={id} component={component} durationInFrames={dur} fps={FPS} width={W} height={H} defaultProps={{}} />
);

export const RemotionRoot: React.FC = () => (
    <>
        {/* === Original compositions (with custom props) === */}
        <Composition id="StatReveal" component={StatReveal} durationInFrames={D} fps={FPS} width={W} height={H}
            defaultProps={{ statValue: "3.5x", label: "MORE VIEWS", icon: "activity", mood: "upbeat" as const }} />
        <Composition id="Comparison" component={Comparison} durationInFrames={D} fps={FPS} width={W} height={H}
            defaultProps={{ leftLabel: "BEFORE", leftValue: "$100", rightLabel: "AFTER", rightValue: "$10,000", mood: "upbeat" as const }} />
        <Composition id="KineticText" component={KineticText} durationInFrames={D} fps={FPS} width={W} height={H}
            defaultProps={{ line: "This changes everything", mood: "serious" as const }} />
        <Composition id="CaptionOverlay" component={CaptionOverlay} durationInFrames={900} fps={FPS} width={W} height={H}
            defaultProps={{ words: [] as Array<{ text: string; start: number; end: number }>, commentHook: "", totalDuration: 30 }} />
        <Composition id="SceneTransition" component={SceneTransition} durationInFrames={12} fps={FPS} width={W} height={H}
            defaultProps={{ type: "crossfade" as const }} />

        {/* === List Animations (12) === */}
        {S("ListAsymmetric3", ListAsymmetric3)}
        {S("ListNumberedVertical", ListNumberedVertical)}
        {S("ListStaggered", ListStaggered)}
        {S("ListFullscreenSequence", ListFullscreenSequence)}
        {S("ListMinimalLeft", ListMinimalLeft)}
        {S("ListStatsFocused", ListStatsFocused)}
        {S("ListTimeline", ListTimeline)}
        {S("ListUnevenGrid", ListUnevenGrid)}
        {S("ListTwoColumnCompare", ListTwoColumnCompare)}
        {S("ListSimpleText", ListSimpleText)}
        {S("ListHorizontalPeek", ListHorizontalPeek)}
        {S("ListHeroWithList", ListHeroWithList)}

        {/* === Data Animations (8) === */}
        {S("DataBarChart", DataBarChart)}
        {S("DataLineChart", DataLineChart)}
        {S("DataPieChart", DataPieChart)}
        {S("DataStatsCards", DataStatsCards)}
        {S("DataProgressBars", DataProgressBars)}
        {S("DataTimeline", DataTimeline)}
        {S("DataRanking", DataRanking)}
        {S("DataGauge", DataGauge)}

        {/* === Text Animations (12) === */}
        {S("TextKinetic", TextKinetic)}
        {S("TextScramble", TextScramble)}
        {S("TextWave", TextWave)}
        {S("TextSplit", TextSplit)}
        {S("TextMaskReveal", TextMaskReveal)}
        {S("TextGlitch", TextGlitch)}
        {S("TextNeon", TextNeon)}
        {S("Text3DFlip", Text3DFlip)}
        {S("TextTypewriter", TextTypewriter)}
        {S("TextCounter", TextCounter)}
        {S("TextGradient", TextGradient)}
        {S("TextExplode", TextExplode)}

        {/* === Roller Animations (22) === */}
        {S("RollerSlotMachine", RollerSlotMachine)}
        {S("RollerFlip", RollerFlip)}
        {S("RollerFadeSlide", RollerFadeSlide)}
        {S("RollerBlur", RollerBlur)}
        {S("RollerScaleBounce", RollerScaleBounce)}
        {S("RollerGlitch", RollerGlitch)}
        {S("RollerWave", RollerWave)}
        {S("RollerTypewriter", RollerTypewriter)}
        {S("RollerLiquid", RollerLiquid)}
        {S("RollerVerticalList", RollerVerticalList)}
        {S("RollerDrum", RollerDrum)}
        {S("RollerMaskSlide", RollerMaskSlide)}
        {S("RollerSlotReveal", RollerSlotReveal)}
        {S("RollerDramaticStop", RollerDramaticStop)}
        {S("RollerMultiSlot", RollerMultiSlot)}
        {S("RollerCountdown", RollerCountdown)}
        {S("RollerOutlineHighlight", RollerOutlineHighlight)}
        {S("RollerPerspectiveStripes", RollerPerspectiveStripes)}
        {S("RollerShuffle", RollerShuffle)}
        {S("Roller3DCarousel", Roller3DCarousel)}
        {S("RollerSplitFlap", RollerSplitFlap)}
        {S("RollerGradientWave", RollerGradientWave)}

        {/* === Cinematic Animations (10) === */}
        {S("CinematicEpic", CinematicEpic)}
        {S("CinematicHorror", CinematicHorror)}
        {S("CinematicRomance", CinematicRomance)}
        {S("CinematicAction", CinematicAction)}
        {S("CinematicDocumentary", CinematicDocumentary)}
        {S("CinematicSciFi", CinematicSciFi)}
        {S("CinematicNoir", CinematicNoir)}
        {S("CinematicAnime", CinematicAnime)}
        {S("CinematicVintage", CinematicVintage)}
        {S("CinematicMinimalEnd", CinematicMinimalEnd)}
    </>
);
