import React from "react";
import { AbsoluteFill } from "remotion";
import compatibility from "../motion-compatibility.json";
import {
  ALL_VISUAL_PRIMITIVES,
  MotionDesignSystem,
  type VisualOperation,
  type VisualPrimitive,
  type VisualState,
} from "./MotionDesignSystem";

export type CompatibilityCase = { operation: VisualOperation; primitive: VisualPrimitive };
export const COMPATIBILITY_CASES: CompatibilityCase[] = Object.entries(compatibility).flatMap(([operation, primitives]) =>
  primitives.map((primitive) => ({ operation: operation as VisualOperation, primitive: primitive as VisualPrimitive }))
);
export const CASES_PER_PAGE = 16;
export const COMPATIBILITY_PAGE_COUNT = Math.ceil(COMPATIBILITY_CASES.length / CASES_PER_PAGE);
const columns = 4;
const cellWidth = 480;
const cellHeight = 270;
const scale = 0.42;

function Cell({ item, index, state }: { item: CompatibilityCase; index: number; state: VisualState }) {
  const column = index % columns;
  const row = Math.floor(index / columns);
  return <div data-case={`${item.operation}/${item.primitive}`} style={{
    position: "absolute", left: column * cellWidth + 12, top: row * cellHeight + 22,
    width: 1080, height: 510, transform: `scale(${scale})`, transformOrigin: "top left",
  }}>
    <MotionDesignSystem
      primitive={item.primitive}
      operation={item.operation}
      state={state}
      diagnosticMode="foreground-only"
      numericValue={item.operation === "counter" || item.primitive === "quantity" ? 73 : null}
      elements={[item.primitive.replaceAll("-", " "), "evidence", "result", "limit"]}
      before="before" after="after" keyText="resolved"
    />
  </div>;
}

export const MotionCompatibilityMatrix: React.FC<{ page?: number }> = ({ page = 0 }) => {
  const cases = COMPATIBILITY_CASES.slice(page * CASES_PER_PAGE, (page + 1) * CASES_PER_PAGE);
  return <AbsoluteFill style={{ background: "#000", fontFamily: "Inter, Arial, sans-serif" }}>
    {cases.map((item, index) => <Cell key={`${item.operation}/${item.primitive}`} item={item} index={index} state="mechanism" />)}
  </AbsoluteFill>;
};

export const PrimitiveStateMatrix: React.FC<{ page?: number; state?: "hypothesis" | "contradiction" }> = ({ page = 0, state = "hypothesis" }) => {
  const items = ALL_VISUAL_PRIMITIVES.slice(page * CASES_PER_PAGE, (page + 1) * CASES_PER_PAGE);
  return <AbsoluteFill style={{ background: "#000", fontFamily: "Inter, Arial, sans-serif" }}>
    {items.map((primitive, index) => <Cell key={primitive} item={{ operation: "payoff", primitive }} index={index} state={state} />)}
  </AbsoluteFill>;
};

export const PRIMITIVE_STATE_PAGE_COUNT = Math.ceil(ALL_VISUAL_PRIMITIVES.length / CASES_PER_PAGE);
