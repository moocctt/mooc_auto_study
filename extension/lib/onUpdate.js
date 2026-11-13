const UPDATE_NOTICE_KEY = "mooc.updateNotice";
function normalizeVersion(v) {
  if (typeof v !== "string") return [0, 0, 0];
  const seg = v.split(".").slice(0, 3).map((s) => {
    const m = s.match(/\d+/);
    return m ? Number(m[0]) : 0;
  });
  return [seg[0] ?? 0, seg[1] ?? 0, seg[2] ?? 0];
}
function isUpgrade(previous, current) {
  if (typeof previous !== "string" || !previous) return false;
  if (typeof current !== "string" || !current) return false;
  const [a1, a2, a3] = normalizeVersion(previous);
  const [b1, b2, b3] = normalizeVersion(current);
  if (b1 !== a1) return b1 > a1;
  if (b2 !== a2) return b2 > a2;
  return b3 > a3;
}
function updateNotice(previous, current, now = Date.now()) {
  if (!isUpgrade(previous, current)) return null;
  return { from: previous, to: current, at: now };
}
export {
  UPDATE_NOTICE_KEY,
  isUpgrade,
  normalizeVersion,
  updateNotice
};
