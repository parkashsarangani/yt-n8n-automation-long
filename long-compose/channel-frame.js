// Deterministic channel motif, independent of generated artwork or fallback.
const palette = { charcoal: "0x101217", teal: "0x195C60", ivory: "0xF3EBDD", amber: "0xE8B86A" };
function channelFrame(width, height, thumbnail = false) {
  const box = (x, y, w, h, color) => `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=${color}:t=fill`;
  return [
    box(0, 0, width, Math.round(height * (thumbnail ? 0.04 : 0.135)), palette.charcoal),
    ...(thumbnail ? [box(0, 0, width / 2, height, palette.charcoal)] : []),
    box(0, 0, Math.round(width * 0.0125), height, palette.teal),
    box(Math.round(width * 0.025), Math.round(height * 0.025), Math.round(width * 0.025), Math.round(height * 0.008), palette.ivory),
    box(Math.round(width * 0.025), Math.round(height * 0.041), Math.round(width * 0.016), Math.round(height * 0.008), palette.amber),
  ].join(",");
}
module.exports = { channelFrame, palette };
