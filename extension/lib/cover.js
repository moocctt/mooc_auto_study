import { CHART_PALETTE } from "./theme.js";
const hash = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
};
function coverGradient(seed) {
  const h = hash(String(seed || "x"));
  const a = CHART_PALETTE[h % CHART_PALETTE.length];
  let b = CHART_PALETTE[(h >>> 8) % CHART_PALETTE.length];
  if (b === a) b = CHART_PALETTE[(h + 3) % CHART_PALETTE.length];
  return { from: a, to: b };
}
function coverOf(row) {
  const g = coverGradient(String(row.name || ""));
  const img = String(row.cover || "").trim();
  return { img: /^https?:\/\//.test(img) ? img : void 0, ...g };
}
export {
  coverGradient,
  coverOf
};
