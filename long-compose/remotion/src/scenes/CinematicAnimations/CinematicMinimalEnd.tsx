/**
 * CinematicMinimalEnd - ミニマリストエンディング
 */

import { AbsoluteFill, useCurrentFrame } from "remotion";
import { C, lerp, font } from "../../common";

export const CinematicMinimalEnd = ({ startDelay = 0, credits, endTitle }: {
  startDelay?: number;
  credits?: Array<{ label: string; name: string }>;
  endTitle?: string;
}) => {
  const frame = useCurrentFrame();
  const displayCredits = credits ?? [
    { label: "Directed by", name: "John Smith" },
    { label: "Written by", name: "Jane Doe" },
  ];
  const displayEndTitle = endTitle ?? "The End";

  const fadeInOut = (start: number, duration: number) => {
    const progress = frame - startDelay - start;
    if (progress < 0) return 0;
    if (progress < duration / 2) return progress / (duration / 2);
    if (progress < duration) return 1 - (progress - duration / 2) / (duration / 2);
    return 0;
  };

  return (
    <AbsoluteFill style={{ background: C.black }}>
      {/* Credits */}
      {displayCredits.map((credit, i) => (
        <div
          key={`credit-${credit.label}`}
          style={{
            position: "absolute",
            left: "50%",
            top: `${35 + i * 15}%`,
            transform: "translateX(-50%)",
            textAlign: "center",
            opacity: fadeInOut(i * 30, 50),
          }}
        >
          <div
            style={{
              fontFamily: font,
              fontSize: 14,
              color: C.gray[500],
              letterSpacing: 4,
              marginBottom: 15,
            }}
          >
            {credit.label}
          </div>
          <div
            style={{
              fontFamily: font,
              fontSize: 36,
              fontWeight: 300,
              color: C.white,
            }}
          >
            {credit.name}
          </div>
        </div>
      ))}

      {/* "The End" */}
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: "50%",
          transform: "translate(-50%, -50%)",
          textAlign: "center",
          opacity: lerp(frame, [startDelay + 70, startDelay + 90], [0, 1]),
        }}
      >
        <div
          style={{
            fontFamily: font,
            fontSize: 48,
            fontWeight: 300,
            fontStyle: "italic",
            color: C.white,
          }}
        >
          {displayEndTitle}
        </div>
      </div>
    </AbsoluteFill>
  );
};
