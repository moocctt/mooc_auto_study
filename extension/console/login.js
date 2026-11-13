/** 登录页: 布局=主站做法 —— 左栏常驻 APP 二维码, 右栏在「账号登录表单」与「微信扫码」间切换。
 *  移植自 src/components/{Login,LoginHero}.tsx; 二维码/导入/权限等行为逐条对齐。 */
import { addAccount, onLoggedIn, api } from '../lib/actions.js';
import { closeLogin, openModal, toast } from '../lib/store.js';
import { platformGate, openDownload } from './overlays.js';
import { el, svg, buildStamp } from './ui.js';

/* 登录页实例级清理: 每次重建前把旧实例的轮询/定时器全部停掉 */
let cleanups = [];
let onboardShown = false;

/* 首装参数一次性消费: 从地址栏摘掉 onboard, 刷新才不会重放欢迎条 */
function stripOnboard() {
  try {
    const u = new URL(location.href);
    if (!u.searchParams.has('onboard')) return;
    u.searchParams.delete('onboard');
    history.replaceState(null, '', `${u.pathname}${u.search}${u.hash}`);
  } catch { /* 忽略 */ }
}
function onCleanup(fn) { cleanups.push(fn); }
/** 登录视图关闭沿清理: 隐藏 ≠ 卸载, 二维码轮询等必须显式停掉, 否则每 2s 换码轮询到天荒地老 */
export function disposeLogin() { runCleanups(); if (pageHost) delete pageHost.dataset.sig; }
function runCleanups() { for (const fn of cleanups) { try { fn(); } catch { /* 忽略 */ } } cleanups = []; }

export function renderLogin(host, s) {
  pageHost = host;
  const onClose = s.loginOpen ? closeLogin : undefined;
  const sig = JSON.stringify([s.ready, s.loginOpen, s.loginPrefill]);
  if (host.dataset.sig === sig) return;
  host.dataset.sig = sig;
  runCleanups();
  host.replaceChildren(loginView(s, onClose));
}


function loginView(s, onClose) {
  const prefill = s.loginPrefill || '';
  let mode = 'password';
  let remember = false;
  let busyText = '';
  let permState = null;      // null = 检查中
  let permAsked = null;
  let awaitingImport = false;
  const errP = el('p', { class: 'login-err', role: 'alert', 'aria-live': 'polite' });

  /* 「去官网登录」会写一个 5 分钟内的意图标记; 浮层据此决定要不要监听官网令牌 */
  (async () => {
    if (!onClose) return;
    const storage = globalThis.chrome?.storage?.local;
    if (!storage?.get) return;
    try {
      const v = await storage.get('mooc.awaitImport');
      const at = Number(v?.['mooc.awaitImport'] || 0);
      if (at && Date.now() - at < 5 * 60e3) { awaitingImport = true; startImportWatcher(); }
    } catch { /* 读不到意图标记 = 没点过「去官网登录」 */ }
  })();

  /* 首装引导（background onInstalled 带 ?onboard=1）: 欢迎提示两条路径。
   * 只提示一次: 参数即刻从 URL 摘掉, 并用 mooc.onboardSeen 兜底;
   * 已有登录态（vault 里有令牌）时不再提示 —— 否则每次刷新都会重放。 */
  try {
    if (!onboardShown && new URLSearchParams(location.search).get('onboard') === '1') {
      onboardShown = true;
      stripOnboard();
      const storage = globalThis.chrome?.storage?.local;
      void (async () => {
        let seen = false;
        try {
          const got = await storage?.get?.(['mooc.onboardSeen', 'mooc.vault.tokens']);
          seen = !!(got?.['mooc.onboardSeen'] || got?.['mooc.vault.tokens']);
        } catch { /* 读不到就按未提示处理 */ }
        if (seen) return;
        try { await storage?.set?.({ 'mooc.onboardSeen': Date.now() }); } catch { /* 忽略 */ }
        const t = setTimeout(() => toast('欢迎安装！授权访问官网后登录态会自动导入，也可扫码 / 账号密码登录', 'info', 8000), 600);
        onCleanup(() => clearTimeout(t));
      })();
    }
  } catch { /* 忽略 */ }

  /* 平台域名授权状态（商店版为可选授权; 未授权时不发平台请求, 避免 CORS 报错） */
  (async () => {
    const perm = globalThis.chrome?.permissions;
    const storage = globalThis.chrome?.storage?.local;
    if (!perm?.contains) { permState = true; permAsked = false; renderPermCard(); return; }
    try {
      permState = await new Promise((res) => perm.contains({ origins: ['https://mooc.ctt.cn/*'] }, res));
    } catch { permState = false; }
    try {
      const v = await storage?.get?.('mooc.permAsked');
      permAsked = !!v?.['mooc.permAsked'];
    } catch { permAsked = false; }
    renderPermCard();
    if (permState === true) startImportWatcher();
  })();

  function requestPerm() {
    const perm = globalThis.chrome?.permissions;
    const storage = globalThis.chrome?.storage?.local;
    try { storage?.set?.({ 'mooc.permAsked': true }); } catch { /* 忽略 */ }
    permAsked = true;
    if (!perm?.request) { renderPermCard(); return; }
    void (async () => {
      const ok = await new Promise((res) => perm.request({ origins: ['https://mooc.ctt.cn/*'] }, res));
      if (!ok) { toast('未授权 —— 无法与平台通信', 'err'); renderPermCard(); return; }
      permState = true;
      renderPermCard();
      startImportWatcher();
    })();
  }

  /* 无感导入: 官网内容脚本捕获的令牌 → 自动 adoptSession 登录（检测到捕获或用户手动登录为止） */
  function startImportWatcher() {
    if (importWatcherStarted) return;
    if (permState !== true) return;
    // 整页登录（首装）直接监听; 浮层只有在用户点过「去官网登录」时才监听 ——
    // 否则「添加平台账号」会被官网现有会话劫持成另一个账号。
    if (onClose && !awaitingImport) return;
    const storage = globalThis.chrome?.storage?.local;
    if (!storage?.get) return;
    importWatcherStarted = true;
    let alive = true;
    onCleanup(() => { alive = false; });
    const tryOnce = async () => {
      const got = await storage.get(['mooc.capturedToken', 'mooc.importSuppressed', 'mooc.awaitImport']);
      if (got?.['mooc.importSuppressed']) return true;   // 用户已登出/跳过: 不自动导入
      const cap = got?.['mooc.capturedToken'];
      if (!cap?.token?.access_token) return false;
      await storage.remove('mooc.capturedToken');
      try {
        const d = await api.consoleApi.adoptSession(cap.token);
        if (!alive) return true;
        try { storage.remove('mooc.importSuppressed'); storage.remove('mooc.awaitImport'); } catch { /* 忽略 */ }
        toast('已从学院官网导入登录态', 'ok');
        onLoggedIn(d);
        if (onClose) onClose();
        return true;
      } catch { /* 令牌无效: 静默放弃, 用户走扫码/账密 */ }
      return true;
    };
    void (async () => {
      for (let i = 0; i < 60 && alive; i++) {
        if (await tryOnce()) return;
        await new Promise((r) => setTimeout(r, 2000));
      }
      // 浮层里不提示「没检测到」: 用户是点「重新登录」进来的, 不该再被催一次
      if (alive && !onClose) toast('未检测到官网登录态，可扫码 / 账号密码登录', 'info', 6000);
    })();
  }

  const submit = async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    const user = String(fd.get('username') || '').trim();
    const pass = String(fd.get('password') || '');
    errP.textContent = '';
    setBusy('登录中…');
    const t0 = Date.now();
    const tick = setInterval(() => setBusy(`登录中… ${Math.round((Date.now() - t0) / 1000)}s`), 1000);
    onCleanup(() => clearInterval(tick));
    try {
      // 节流/失败计数/锁定都在 addAccount 里统一做（账密页与「添加账号」弹窗共用）
      const d = await addAccount(user, pass, remember);
      clearInterval(tick);
      setBusy('');
      onLoggedIn(d);
    } catch (ex) {
      clearInterval(tick);
      setBusy('');
      errP.textContent = `${String(ex.message || '')}（build ${buildStamp()}）`;
    }
  };

  function setBusy(text) {
    busyText = text;
    const btn = pageHost?.querySelector('.login-submit');
    if (btn) { btn.textContent = busyText || '登录'; btn.disabled = !!busyText; btn.setAttribute('aria-busy', String(!!busyText)); }
  }

  const page = el('div', { class: 'login-page' });

  /* 页头 70px */
  const header = el('header', { class: 'login-header' },
    el('div', { class: 'login-brand' },
      el('img', { src: '/icon/48.png', alt: '', width: 34, height: 34 }),
      el('span', { class: 'main', text: '烟草网络学院' }),
      el('span', { class: 'sep', 'aria-hidden': 'true' }),
      el('span', { class: 'sub', text: '学习助手' }),
    ),
    el('div', { class: 'note' }, '非官方扩展 · 仅管理本人学习进度'),
    onClose ? el('button', { class: 'login-close', 'aria-label': '关闭登录页', text: '✕', onclick: onClose }) : '',
  );

  /* 中间区: 横幅铺满可视高度, 卡片按视口定位（矮视口时这里自己滚） */
  const hero = el('div', { class: 'login-hero', 'aria-hidden': 'true', html: HERO_SVG });

  const card = el('div', { class: 'login-card' });

  /* 右上角折角 = 登录方式切换按钮 */
  const modeBtn = el('button', {
    type: 'button', class: 'login-fold tl',
    'aria-label': mode === 'password' ? '切换到微信扫码登录' : '返回账号密码登录',
    title: mode === 'password' ? '微信扫码登录' : '返回账号密码登录',
  });
  modeBtn.addEventListener('click', () => {
    mode = mode === 'password' ? 'wechat' : 'password';
    modeBtn.setAttribute('aria-label', mode === 'password' ? '切换到微信扫码登录' : '返回账号密码登录');
    modeBtn.setAttribute('title', mode === 'password' ? '微信扫码登录' : '返回账号密码登录');
    renderFoldIcon();
    renderRightPane();
  });

  /* 右下角折角 = APP 下载 */
  const dlBtn = el('button', { type: 'button', class: 'login-fold br', 'aria-label': '下载烟草网络学院 APP', title: '下载 APP' });
  dlBtn.addEventListener('click', () => openDownload());

  function renderFoldIcon() {
    modeBtn.replaceChildren(svg({ viewBox: '0 0 44 44' }, FOLD_SVG(mode)),
      el('span', { class: 'fold-tip', 'aria-hidden': 'true', text: mode === 'password' ? '微信扫码' : '返回账号密码' }));
    dlBtn.replaceChildren(svg({ viewBox: '0 0 44 44' }, DL_FOLD_SVG),
      el('span', { class: 'fold-tip', 'aria-hidden': 'true', text: '下载 APP' }));
  }
  renderFoldIcon();

  /* 左栏: APP 二维码常驻（窄屏隐藏） */
  const appPane = el('section', { class: 'login-pane login-side-app' },
    el('h2', { class: 'pane-title', text: '烟草网络学院 APP 扫码登录' }),
    qrPane('app', (d) => { onLoggedIn(d); if (onClose) onClose(); }),
    el('p', { class: 'pane-hint', text: '打开 烟草网络学院 APP，用「扫一扫」扫描上方二维码' }),
  );
  const sep = el('span', { class: 'pane-sep', 'aria-hidden': 'true' });

  /* 右栏: 账号密码 或 微信扫码 */
  let rightPane = el('section', { class: 'login-pane' });
  function renderRightPane() {
    if (mode === 'password') {
      const userInput = el('input', {
        name: 'username', type: 'text', placeholder: '请输入账号/手机号', autocomplete: 'username',
        class: 'login-input', value: prefill,
      });
      const form = el('form', { class: 'login-form' },
        userInput,
        el('input', { name: 'password', type: 'password', placeholder: '请输入密码', autocomplete: 'current-password', class: 'login-input' }),
        el('button', { type: 'submit', class: 'login-submit', text: busyText || '登录', 'aria-busy': String(!!busyText) }),
        errP,
        el('label', { class: 'remember-label' }, el('input', { type: 'checkbox' }), '记住凭据（本机存储，公共电脑请勿勾选）'),
      );
      const rememberCheck = form.querySelector('input[type=checkbox]');
      rememberCheck.addEventListener('change', () => { remember = rememberCheck.checked; });
      form.addEventListener('submit', submit);
      rightPane.replaceChildren(
        el('h2', { class: 'pane-title', text: '账号登录' }),
        form,
        el('div', { class: 'login-build' },
          platformGate({ block: true, children: el('span', { style: { display: 'none' } }) }),
          el('p', { text: `build ${buildStamp()}` }),
        ),
      );
    } else {
      rightPane.replaceChildren(
        el('h2', { class: 'pane-title', text: '微信扫码登录' }),
        qrPane('wechat', (d) => { onLoggedIn(d); if (onClose) onClose(); }),
        el('p', { class: 'pane-hint', text: '打开微信，用「扫一扫」扫描上方二维码' }),
        el('div', { class: 'login-build' },
          platformGate({ block: true, children: el('span', { style: { display: 'none' } }) }),
          el('p', { text: `build ${buildStamp()}` }),
        ),
      );
    }
  }
  renderRightPane();

  /* 平台授权卡（未授权时盖在卡片上） */
  function renderPermCard() {
    const old = card.querySelector('.perm-card');
    if (permState !== false) { old?.remove(); return; }
    const pcard = el('div', { class: 'perm-card' },
      el('p', { class: 't', text: '授权访问学院官网' }),
      el('p', { class: 'd' }, '扩展需要访问 mooc.ctt.cn 才能读取二维码与登录。授权后，若你已在本机登录过官网，登录态会',
        el('b', {}, '自动无感导入'), '；也可直接扫码 / 账号密码登录。仅访问该域名，可随时撤销。'),
    );
    if (permAsked === false) {
      pcard.append(el('button', { class: 'btn btn-primary', text: '授权访问学院官网', onclick: requestPerm, style: { marginTop: '8px', width: '100%' } }));
    } else {
      pcard.append(el('button', { class: 'retry', text: '已询问过授权 —— 点此重新尝试', onclick: requestPerm }));
    }
    old?.remove();
    card.append(pcard);
  }

  const mid = el('div', { class: 'login-mid' }, hero,
    el('div', { class: 'login-card-zone' }, card));

  card.append(modeBtn, dlBtn, appPane, sep, rightPane);

  /* 页脚 80px */
  const footer = el('footer', { class: 'login-footer' },
    el('span', { text: '非官方扩展 · 与学习平台及其运营方无关联 · 数据仅存本机' }),
    el('span', { class: 'warn', text: '本扩展不含刷课等违反平台规则的功能，请合规使用' }),
  );

  page.append(header, mid, footer);
  return page;
}

/* 登录页实例根（setBusy 等实例函数用它查当前 DOM） */
let pageHost = null;

/* 无感导入监听只启动一次（权限就绪与意图标记两处触发） */
let importWatcherStarted = false;

/** 单个二维码面板: 取码 → 轮询 → 过期自动换新码（登录成功时随页面卸载停止） */
function qrPane(kind, handleDone) {
  let qr = null;      // { png, note }
  let attempt = 0;
  const box = el('div', { class: 'qr-box' });
  const note = el('p', { class: 'qr-note' });
  const refreshBtn = el('button', { class: 'qr-refresh', text: '刷新二维码' });
  refreshBtn.addEventListener('click', () => { qr = null; attempt++; start(); });

  const pane = el('div', {}, box, note, refreshBtn);

  let alive = true;
  onCleanup(() => { alive = false; });

  function render() {
    if (qr?.png) {
      box.replaceChildren(el('img', { src: qr.png, width: 160, height: 160, alt: `${kind === 'wechat' ? '微信' : 'APP'} 登录二维码` }));
    } else {
      box.replaceChildren(el('span', { class: 'qr-empty' },
        svg({ viewBox: '0 0 24 24', width: 52, height: 52, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.3, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
          '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v2M14 20h3M20 19v2"/>'),
        el('span', { text: '正在获取二维码…' })));
    }
    const retry = qr?.note.includes('取码失败');
    note.textContent = qr?.note || '';
    note.classList.toggle('err', !!retry);
    refreshBtn.textContent = retry ? '重新获取' : '刷新二维码';
    refreshBtn.setAttribute('aria-label', retry ? '重新获取二维码' : '刷新二维码');
    refreshBtn.classList.toggle('retry', !!retry);
  }

  const apiFetchIssue = async (k) => {
    const res = await api.fetch(`/api/qr/issue?kind=${k}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  };
  const apiFetchCheck = async (k, uuid) => {
    const res = await api.fetch(`/api/qr/check?kind=${k}&uuid=${encodeURIComponent(uuid)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  };

  async function start() {
    render();
    let errStreak = 0;
    for (let cycle = 1; ; cycle++) {          // 不限次数: 过期即换新码, 登录成功/卸载才停
      if (!alive) return;
      let uuid = '';
      let d;
      try {
        d = await apiFetchIssue(kind);
        if (!alive) return;
        uuid = d.uuid;
        qr = { png: d.png, note: cycle > 1 ? `已刷新（第 ${cycle} 张）· 等待扫码…` : '等待扫码…' };
      } catch (ex) {
        qr = { png: '', note: `取码失败：${ex.message}（可点「重新获取」；build ${buildStamp()}）` };
        render();
        return;
      }
      render();
      const deadline = Date.now() + (d.ttl || 55000);
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, d.interval || 2000));
        if (!alive) return;
        let r;
        try {
          r = await apiFetchCheck(kind, uuid);
        } catch {
          if (qr) { qr = { ...qr, note: `网络异常, 重试中…（build ${buildStamp()}）` }; render(); }
          continue;
        }
        if (!alive) return;   // await 期间可能已登录成功 → 页面卸载
        if (r.done) { handleDone(r); return; }
        if (r.error) {
          // 平台按出口 IP 区分行为（境内直连可能对个别码 422）: 自动换新码重试 ≤2 次, 仍失败才停
          if (errStreak < 2) {
            errStreak++;
            if (qr) { qr = { ...qr, note: `${r.error}（自动换新码…）` }; render(); }
            break;   // 跳出轮询 while, 进入下一张码
          }
          qr = { png: '', note: r.error };
          render();
          return;
        }
        errStreak = 0;
      }
      if (alive && qr) { qr = { ...qr, note: '二维码已过期，正在换新…' }; render(); }
    }
  }
  void start();
  return pane;
}

/* ── 登录页天空横幅: SVG 还原主站取景与配色（不用对方品牌位图, 见 DESIGN.md）────── */
const HERO_SVG = `<svg viewBox="0 0 1440 740" preserveAspectRatio="xMidYMid slice" role="presentation">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#4a97cd"/><stop offset="26%" stop-color="#5ea8d2"/>
      <stop offset="52%" stop-color="#7cbcd9"/><stop offset="72%" stop-color="#a8cee2"/>
      <stop offset="88%" stop-color="#cde2ea"/><stop offset="100%" stop-color="#e9f3f7"/>
    </linearGradient>
    <radialGradient id="haze" cx="52%" cy="80%" r="58%">
      <stop offset="0%" stop-color="#f4fafb" stop-opacity="0.85"/>
      <stop offset="55%" stop-color="#e7f2f6" stop-opacity="0.38"/>
      <stop offset="100%" stop-color="#e7f2f6" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="ridgeFar" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#a6c6d5"/><stop offset="100%" stop-color="#c6dde6"/>
    </linearGradient>
    <linearGradient id="ridgeMid" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#82aabd"/><stop offset="100%" stop-color="#a4c6d4"/>
    </linearGradient>
    <linearGradient id="ridgeNear" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#5b7d8b"/><stop offset="52%" stop-color="#6d8d99"/>
      <stop offset="100%" stop-color="#8aa7b2"/>
    </linearGradient>
    <filter id="soft" x="-5%" y="-20%" width="110%" height="140%"><feGaussianBlur stdDeviation="2.2"/></filter>
  </defs>
  <rect width="1440" height="740" fill="url(#sky)"/>
  <g filter="url(#soft)" opacity="0.8">
    <path fill="url(#ridgeFar)" d="M0 740 L0 595 L66 595 L161 567 L234 556 L320 582 L385 559 L450 583 L494 556 L551 582 L639 574 L682 566 L743 588 L808 592 L873 592 L932 564 L995 575 L1044 556 L1135 571 L1217 586 L1298 559 L1364 574 L1440 575 L1440 740 Z"/>
  </g>
  <path fill="url(#ridgeMid)" opacity="0.92" d="M0 740 L0 636 L94 611 L164 593 L207 626 L295 626 L336 604 L432 637 L528 588 L599 611 L643 603 L706 626 L746 645 L816 632 L889 610 L933 643 L1024 606 L1083 646 L1154 615 L1199 615 L1294 588 L1347 620 L1400 628 L1440 638 L1440 740 Z"/>
  <path fill="url(#ridgeNear)" d="M0 740 L0 651 L61 632 L111 634 L178 651 L245 669 L284 642 L372 675 L424 679 L509 675 L561 658 L641 694 L705 633 L744 692 L783 645 L841 697 L899 660 L983 686 L1036 657 L1077 675 L1121 672 L1214 647 L1256 698 L1334 698 L1387 652 L1440 692 L1440 740 Z"/>
  <rect width="1440" height="740" fill="url(#haze)"/>
</svg>`;

/* 折角图形随模式切换: 账密表单 → 半个二维码（扫码）; 微信模式 → 半个电脑屏（回账密） */
function FOLD_SVG(mode) {
  const inner = mode === 'password'
    ? `<rect x="27" y="2" width="13" height="13" fill="none" stroke="#fff" stroke-width="2.6"/>
       <rect x="31" y="6" width="5" height="5" fill="#fff"/>
       <rect x="4" y="30" width="3" height="3" fill="#fff" opacity="0.85"/>
       <rect x="9" y="35" width="3" height="3" fill="#fff" opacity="0.6"/>`
    : `<rect x="27" y="2" width="14" height="10" fill="none" stroke="#fff" stroke-width="2.2"/>
       <path d="M30 6 h8 M30 9 h5" stroke="#fff" stroke-width="1.6" stroke-linecap="round" opacity="0.9"/>
       <path d="M34 12 v3 M29 15 h10" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/>`;
  return `<defs><clipPath id="login-fold"><path d="M44 0 L44 34 L10 0 Z"/></clipPath></defs>
    <g clip-path="url(#login-fold)">
      <rect width="44" height="44" class="fold-fill"/>
      ${inner}
      <path d="M44 34 L10 0" stroke="#fff" stroke-width="1" opacity="0.35"/>
    </g>`;
}

/* 半部手机 + 下箭头: 「装到手机上」 */
const DL_FOLD_SVG = `<defs><clipPath id="login-fold-br"><path d="M44 0 L44 44 L0 44 Z"/></clipPath></defs>
  <g clip-path="url(#login-fold-br)">
    <rect width="44" height="44" class="fold-fill"/>
    <rect x="28" y="22" width="12" height="16" fill="none" stroke="#fff" stroke-width="2.2"/>
    <path d="M34 26 v6 M31.5 29.5 L34 32 L36.5 29.5" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M44 0 L0 44" stroke="#fff" stroke-width="1" opacity="0.35"/>
  </g>`;
