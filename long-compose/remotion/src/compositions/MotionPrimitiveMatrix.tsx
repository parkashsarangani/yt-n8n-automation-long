import React from "react";
import { AbsoluteFill } from "remotion";
import { MotionDesignSystem, RELATIONSHIP_PRIMITIVES, type VisualState, type VisualOperation } from "./MotionDesignSystem";

const operations: VisualOperation[] = ["stack", "timeline", "counter", "compress", "group", "sort", "scale-compare", "payoff"];
const states: VisualState[] = ["hypothesis", "contradiction", "mechanism", "qualification", "payoff"];

export const MotionPrimitiveMatrix: React.FC = () => (
  <AbsoluteFill style={{ background: "#050912", fontFamily: "Inter, Arial, sans-serif" }}>
    {RELATIONSHIP_PRIMITIVES.map((primitive, index) => {
      const column = index % 3;
      const row = Math.floor(index / 3);
      return <div key={primitive} data-primitive={primitive} style={{
        position: "absolute",
        left: 22 + column * 636,
        top: 16 + row * 211,
        width: 1080,
        height: 510,
        transform: "scale(0.56, 0.37)",
        transformOrigin: "top left",
      }}>
        <MotionDesignSystem
          primitive={primitive}
          operation={operations[index % operations.length]}
          state={states[index % states.length]}
          numericValue={index === 12 ? 73 : null}
          elements={[primitive.replaceAll("-", " "), "evidence", "result", "limit"]}
          before="before"
          after="after"
          keyText="resolved"
        />
      </div>;
    })}
  </AbsoluteFill>
);
