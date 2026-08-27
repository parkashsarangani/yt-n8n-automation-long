import React from "react";
import { AbsoluteFill } from "remotion";
import {
  ALL_VISUAL_PRIMITIVES,
  MotionDesignSystem,
  RELATIONSHIP_PRIMITIVES,
  type SubjectPrimitive,
  type VisualOperation,
  type VisualState,
} from "./MotionDesignSystem";

const operations: VisualOperation[] = ["stack", "timeline", "counter", "compress", "group", "sort", "scale-compare", "payoff"];
const states: VisualState[] = ["hypothesis", "contradiction", "mechanism", "qualification", "payoff"];
const subjects = ALL_VISUAL_PRIMITIVES.filter((primitive): primitive is SubjectPrimitive =>
  ["particles","rays","wave","horizon","spectrum","path","shells","objects"].includes(primitive)
);

function Matrix({ primitives, columns, scale, cellWidth, cellHeight }: {
  primitives: typeof ALL_VISUAL_PRIMITIVES; columns: number; scale: number; cellWidth: number; cellHeight: number;
}) {
  return <AbsoluteFill style={{ background: "#050912", fontFamily: "Inter, Arial, sans-serif" }}>
    {primitives.map((primitive, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      const operation = operations[index % operations.length]!;
      return <div key={primitive} data-primitive={primitive} style={{
        position: "absolute", left: 18 + column * cellWidth, top: 18 + row * cellHeight,
        width: 1080, height: 510, transform: `scale(${scale})`, transformOrigin: "top left",
      }}>
        <MotionDesignSystem primitive={primitive} operation={operation} state={states[index % states.length]!}
          numericValue={operation === "counter" || primitive === "quantity" ? 73 : null}
          elements={[primitive.replaceAll("-", " "), "evidence", "result", "limit"]}
          before="before" after="after" keyText="resolved" />
      </div>;
    })}
  </AbsoluteFill>;
}

export const MotionPrimitiveMatrix: React.FC = () =>
  <Matrix primitives={RELATIONSHIP_PRIMITIVES} columns={5} scale={0.34} cellWidth={382} cellHeight={265} />;

export const SubjectPrimitiveMatrix: React.FC = () =>
  <Matrix primitives={subjects} columns={4} scale={0.42} cellWidth={474} cellHeight={510} />;
