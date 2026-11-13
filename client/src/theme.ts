// 设计令牌唯一来源（hex 值只在这里出现一次）
// app.css 只写 var(--…) 引用，:root 变量由 main.tsx 在渲染前注入
// .impeccable.md 记录设计原则与取舍

export const tokens = {
  /* neutral（绿相 tint，拒绝死灰） */
  ink: '#27322b',
  ink2: '#5a675f',
  ink3: '#67736b',
  line: '#e3e7e2',
  surface: '#fdfdfb',
  bg: '#f6f8f6',

  /* brand（绿为唯一 accent） */
  green: '#007556',
  greenDeep: '#005c43',
  greenWash: '#eef4f0',

  /* antd token 映射 */
  colorLink: '#006b4e',
} as const;

// 渲染前同步注入 :root 变量，避免首帧缺变量
export function injectCssVars() {
  const s = document.documentElement.style;
  s.setProperty('--ink', tokens.ink);
  s.setProperty('--ink-2', tokens.ink2);
  s.setProperty('--ink-3', tokens.ink3);
  s.setProperty('--line', tokens.line);
  s.setProperty('--surface', tokens.surface);
  s.setProperty('--bg', tokens.bg);
  s.setProperty('--green', tokens.green);
  s.setProperty('--green-deep', tokens.greenDeep);
  s.setProperty('--green-wash', tokens.greenWash);
}
