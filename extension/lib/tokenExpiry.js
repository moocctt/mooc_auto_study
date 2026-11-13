const EXPIRY_ALARM = "mooc.token-expiry";
const MIN_ALARM_MS = 3e4;
const MAX_ALARM_MS = 24 * 36e5;
const GRACE_MS = 1500;
function nextExpiryDelay(tokens, now = Date.now()) {
  const map = tokens && typeof tokens === "object" ? tokens : {};
  let nextAt = Number.POSITIVE_INFINITY;
  for (const t of Object.values(map)) {
    const tok = t;
    const ttl = Number(tok?.expires_in);
    const at = Number(tok?.obtainedAt);
    if (ttl > 0 && at > 0 && at + ttl * 1e3 > now) nextAt = Math.min(nextAt, at + ttl * 1e3);
  }
  if (!Number.isFinite(nextAt)) return null;
  return Math.min(Math.max(nextAt - now + GRACE_MS, MIN_ALARM_MS), MAX_ALARM_MS);
}
export {
  EXPIRY_ALARM,
  MAX_ALARM_MS,
  MIN_ALARM_MS,
  nextExpiryDelay
};
