const KEY = "mooc.console.sfx";
let ctx = null;
function readEnabled() {
  try {
    return localStorage.getItem(KEY) !== "0";
  } catch {
    return true;
  }
}
let enabled = readEnabled();
const sfxEnabled = () => enabled;
function setSfxEnabled(on) {
  enabled = on;
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
  }
}
const TONES = {
  ok: { f: [660, 990], type: "sine", dur: 0.11, gain: 0.055 },
  err: { f: [300, 240], type: "triangle", dur: 0.16, gain: 0.05 }
};
function sfx(kind) {
  if (!enabled) return;
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AC) return;
  try {
    ctx ??= new AC();
    if (ctx.state === "suspended") void ctx.resume();
    const t = TONES[kind];
    const start = ctx.currentTime;
    t.f.forEach((freq, i) => {
      const at = start + i * t.dur;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = t.type;
      osc.frequency.setValueAtTime(freq, at);
      gain.gain.setValueAtTime(1e-4, at);
      gain.gain.exponentialRampToValueAtTime(t.gain, at + 0.012);
      gain.gain.exponentialRampToValueAtTime(1e-4, at + t.dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at);
      osc.stop(at + t.dur + 0.02);
    });
  } catch {
  }
}
export {
  setSfxEnabled,
  sfx,
  sfxEnabled
};
