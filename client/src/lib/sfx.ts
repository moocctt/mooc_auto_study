// Web Audio 合成音效——克制的体制内沉稳：短促、低增益、正弦/三角波，无采样资源。
// 静音开关持久化在 localStorage；AudioContext 需用户手势后才能出声，
// 所有调用点都挂在点击/状态回调链上，天然满足 autoplay 策略。

let ctx: AudioContext | null = null;
const MUTE_KEY = 'sfx-muted';

export const isMuted = () => localStorage.getItem(MUTE_KEY) === '1';
export const setMuted = (v: boolean) => localStorage.setItem(MUTE_KEY, v ? '1' : '0');

/** 在首次用户手势时预热 AudioContext：
    否则 Context 在无手势时刻创建会停在 suspended，
    而引擎回调（轮询边沿）不处于手势链，resume 会被拒。 */
export function warmup() { void ac(); }

function ac(): AudioContext | null {
  if (isMuted()) return null;
  if (!ctx) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

function tone(freq: number, dur: number, opt: { type?: OscillatorType; gain?: number; delay?: number } = {}) {
  const c = ac();
  if (!c) return;
  const { type = 'sine', gain = 0.06, delay = 0 } = opt;
  const t0 = c.currentTime + delay;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(c.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
}

export const sfx = {
  /** 引擎起步：C5→E5 两个短音上行 */
  start() { tone(523.25, 0.12); tone(659.25, 0.14, { delay: 0.1 }); },
  /** 全部完成：E5→G5→C6 三音收束 */
  done() { tone(659.25, 0.12); tone(783.99, 0.12, { delay: 0.11 }); tone(1046.5, 0.22, { delay: 0.22 }); },
  /** 出错：G3 三角波低音一记 */
  error() { tone(196, 0.25, { type: 'triangle', gain: 0.08 }); },
  /** 停止/配额到顶：G4 单音 */
  stop() { tone(392, 0.1); },
  /** 登录成功：D5→A5 */
  login() { tone(587.33, 0.1); tone(880, 0.16, { delay: 0.09 }); },
};
