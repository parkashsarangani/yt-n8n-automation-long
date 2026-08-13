/**
 * DataStatsCards - スタッツカード - 統計カード（非対称レイアウト）
 */

import { AbsoluteFill, useCurrentFrame, useVideoConfig, spring } from "remotion";
import { C, EASE, lerp, font } from "../../common";

export const DataStatsCards = ({ startDelay = 0, stats }: {
  startDelay?: number;
  stats?: {
    main?: { label?: string; value?: number; change?: string };
    sub?: Array<{ label: string; value: string; color?: string }>;
    footer?: string;
  };
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const mainLabel = stats?.main?.label ?? "TOTAL REVENUE";
  const mainTarget = stats?.main?.value ?? 89420;
  const mainChange = stats?.main?.change ?? "12.5% from last quarter";
  const subStats = stats?.sub ?? [
    { label: "ACTIVE USERS", value: "24,580", color: C.accent },
    { label: "CONVERSION", value: "4.8%", color: C.secondary },
    { label: "ONLINE NOW", value: "1,847", color: C.tertiary },
  ];
  const footer = stats?.footer ?? "Q4 2024 — OVERVIEW";

  // メイン数値のアニメーション
  const mainProgress = spring({
    frame: frame - startDelay,
    fps,
    config: { damping: 20, stiffness: 100 },
  });

  const subProgress = spring({
    frame: frame - startDelay - 15,
    fps,
    config: { damping: 15, stiffness: 150 },
  });

  const countProgress = lerp(frame, [startDelay + 10, startDelay + 50], [0, 1], EASE.out);
  const mainValue = Math.floor(mainTarget * countProgress).toLocaleString();

  return (
    <AbsoluteFill style={{ background: C.gray[950] }}>
      {/* 左側：メイン統計（大きく表示） */}
      <div
        style={{
          position: "absolute",
          left: 80,
          top: "50%",
          transform: `translateY(-50%) translateX(${(1 - mainProgress) * -80}px)`,
          opacity: mainProgress,
        }}
      >
        <div
          style={{
            fontFamily: font,
            fontSize: 12,
            color: C.gray[600],
            letterSpacing: 3,
            marginBottom: 20,
          }}
        >
          {mainLabel}
        </div>
        <div
          style={{
            fontFamily: font,
            fontSize: 120,
            fontWeight: 800,
            color: C.white,
            lineHeight: 0.9,
            letterSpacing: -5,
          }}
        >
          ${mainValue}
        </div>
        <div
          style={{
            fontFamily: font,
            fontSize: 16,
            color: C.success,
            marginTop: 20,
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span style={{ fontSize: 20 }}>↑</span>
          <span>{mainChange}</span>
        </div>
      </div>

      {/* 右側：サブ統計（小さめ、縦積み） */}
      <div
        style={{
          position: "absolute",
          right: 80,
          top: 120,
          width: 280,
          opacity: subProgress,
          transform: `translateY(${(1 - subProgress) * 40}px)`,
        }}
      >
        {subStats.map((stat, i) => (
          <div
            key={`sub-stat-${stat.label}`}
            style={{
              borderLeft: `2px solid ${stat.color ?? [C.accent, C.secondary, C.tertiary][i % 3]}`,
              paddingLeft: 20,
              marginBottom: i < subStats.length - 1 ? 50 : 0,
            }}
          >
            <div
              style={{
                fontFamily: font,
                fontSize: 11,
                color: C.gray[600],
                letterSpacing: 2,
                marginBottom: 8,
              }}
            >
              {stat.label}
            </div>
            <div
              style={{
                fontFamily: font,
                fontSize: 36,
                fontWeight: 700,
                color: C.white,
              }}
            >
              {stat.value}
            </div>
          </div>
        ))}
      </div>

      {/* 下部の装飾ライン */}
      <div
        style={{
          position: "absolute",
          left: 80,
          bottom: 60,
          width: lerp(frame, [startDelay + 30, startDelay + 60], [0, 400]),
          height: 1,
          background: C.gray[800],
        }}
      />

      {/* 右下の番号 */}
      <div
        style={{
          position: "absolute",
          right: 80,
          bottom: 60,
          fontFamily: font,
          fontSize: 11,
          color: C.gray[700],
          letterSpacing: 2,
          opacity: subProgress,
        }}
      >
        {footer}
      </div>
    </AbsoluteFill>
  );
};
