/** 控制台入口: 全局错误接管 / 孤儿页检测 / 启动流程 / hash 路由 / 深链 / 区域渲染编排。
 *  移植自 src/entrypoints/console/{main.tsx,App.tsx}。 */
import { getState, setState, subscribe, go, ALIAS, NAV, openLogin } from '../lib/store.js';
import { disposeLogin } from './login.js';
import { boot, loadState, api } from '../lib/actions.js';
import { pullSyncCreds } from '../lib/vault.js';
import { prefillForAccount, stripLogin, wantsLogin } from '../lib/loginEntry.js';
import { renderSidebar, renderTopbar } from './shell.js';
import { renderModal, renderToasts, renderDrawer, renderLogOverlay, platformGate } from './overlays.js';
import { renderLogin } from './login.js';
import { renderHome } from './views/home.js';
import { renderTasks } from './views/tasks.js';
import { renderSettings } from './views/settings.js';
import { el } from './ui.js';

document.documentElement.dataset.mode = 'client';

/* ── 全局错误接管: 未捕获异常/rejection 打进日志浮层（顶栏 📜 可见）────────── */
let __errSeq = -1;
const reportErr = (kind, detail) => {
  try {
    const logs = [...getState().logs, { seq: __errSeq--, text: `[前端${kind}] ${detail}` }];
    setState({ logs: logs.length > 4000 ? logs.slice(-3000) : logs });
  } catch { /* 日志系统不可用时静默 */ }
  console.error(`[前端${kind}]`, detail);
};

/**
 * 扩展重载后旧标签页成孤儿（chrome.runtime.id 消失），其后所有 fetch 报
 * 「Failed to fetch」且栈帧只会指向 fetch 行，用户完全看不懂。
 * 检测到孤儿态就提示并自动刷新一次（sessionStorage 防循环）。
 */
function maybeOrphan(msg) {
  const orphaned = !globalThis.chrome?.runtime?.id;
  const hint = /Failed to fetch|Extension context invalidated|message channel closed/i.test(msg);
  if (!orphaned && !hint) return false;
  if (orphaned) {
    const k = '__orphan_reloaded';
    if (!sessionStorage.getItem(k)) {
      sessionStorage.setItem(k, '1');
      reportErr('提示', '扩展已更新，本页自动刷新…');
      setTimeout(() => location.reload(), 800);
      return true;
    }
    reportErr('提示', '扩展刚更新过。若仍异常请关闭本标签页后从扩展图标重新打开。');
    return true;
  }
  return false;
}

window.addEventListener('error', (e) => {
  maybeOrphan(e.message) || reportErr('异常', `${e.message} @ ${(e.filename || '').split('/').pop()}:${e.lineno}`);
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  const msg = (r && (r.message || String(r))) || String(r);
  maybeOrphan(msg) || reportErr('网络/异步', msg);
});

// 页面成功启动 → 清除孤儿自动刷新标记（下次扩展更新还能再自动刷一次）
sessionStorage.removeItem('__orphan_reloaded');

// 调试/测试钩子（与旧版 window.__moocApi 同位）
window.__moocApi = api;

/* ── 挂载与区域编排 ────────────────────────────────────── */
const root = document.getElementById('root');

const sidebarHost = el('div');
const topbarHost = el('div');
const permHost = el('div');
const viewHost = el('div');
const loginHost = el('div');

const appHost = el('div', { class: 'app-shell', hidden: true },
  el('a', {
    href: '#main-content', class: 'skip-link', text: '跳到主内容',
  }),
  sidebarHost,
  el('div', { class: 'main-col' },
    topbarHost,
    el('main', { id: 'main-content', class: 'main-scroll' },
      el('div', { class: 'page-wrap' }, permHost, viewHost),
    ),
  ),
);

root.append(loginHost, appHost);
permHost.append(platformGate());

const VIEWS = { report: renderHome, tasks: renderTasks, settings: renderSettings };

/* 深链 ?login=1: 等账号加载完再开, 才能把「失效的那个账号」预填上（扫码/导入账号不预填） */
const deepLink = wantsLogin(location.search);
let openedFromUrl = false;
let deepLinkTimer = 0;
let prevLoginOpen = false;
let activeRoute = '';

// 后台复用已有控制台标签页时不会整页导航（避免打断输入）, 而是发消息让我们开浮层
if (globalThis.chrome?.runtime?.onMessage) {
  const onMsg = (msg) => {
    if (msg?.type !== 'CONSOLE_OPEN_LOGIN') return;
    // 预填由控制台自己算: 后台只有账号 key, 分不清账密账号与扫码账号（后者不能预填姓名）
    const st = getState();
    const walled = st.needLogin?.account ? st.accounts.find((a) => a.key === st.needLogin.account) : null;
    openLogin(prefillForAccount(walled));
  };
  globalThis.chrome.runtime.onMessage.addListener(onMsg);
  window.addEventListener('pagehide', () => {
    try { globalThis.chrome.runtime.onMessage.removeListener(onMsg); } catch { /* 忽略 */ }
  }, { once: true });
}

function update() {
  const s = getState();
  const showLogin = !s.ready || s.loginOpen;

  // 深链: needLogin 由 boot() 末尾异步写入, 比 ready 晚一拍: 给它 1.5s, 拿不到就直接开
  if (deepLink && s.ready && !openedFromUrl) {
    const walled = s.needLogin?.account ? s.accounts.find((a) => a.key === s.needLogin.account) : null;
    if (walled) {
      openedFromUrl = true;
      if (deepLinkTimer) { clearTimeout(deepLinkTimer); deepLinkTimer = 0; }
      openLogin(prefillForAccount(walled));
    } else if (!deepLinkTimer) {
      deepLinkTimer = setTimeout(() => {
        deepLinkTimer = 0;
        if (openedFromUrl) return;
        openedFromUrl = true;
        openLogin();
      }, 1500);
    }
  }

  // 浮层「开 → 关」的边沿才摘参数: 挂载时就摘会与 go() 的 replaceState 抢, 也会让刷新不再弹
  if (prevLoginOpen && !s.loginOpen) {
    disposeLogin();   // 隐藏 ≠ 卸载: 停掉登录视图里的二维码轮询等实例定时器, 否则每 2s loginCheck 到天荒地老
    try { history.replaceState(null, '', stripLogin(location.href)); } catch { /* 忽略 */ }
  }
  prevLoginOpen = s.loginOpen;

  loginHost.hidden = !showLogin;
  appHost.hidden = showLogin;

  if (showLogin) {
    renderLogin(loginHost, s);
  } else {
    // 隐藏 ≠ 卸载: 启动期 ready=false 也会挂登录视图, 数据就绪切走时必须停掉二维码轮询等实例定时器
    disposeLogin();
    // 切页时内容轻微上移淡入（重挂 viewHost, 动画由 CSS anim-fade-up 提供）
    if (s.route !== activeRoute) {
      activeRoute = s.route;
      viewHost.replaceChildren();
      delete viewHost.dataset.sig;
    }
    renderSidebar(sidebarHost, s);
    renderTopbar(topbarHost, s);
    (VIEWS[s.route] || renderHome)(viewHost, s);
  }

  renderDrawer(s);
  renderLogOverlay(s);
  renderModal(s);
  renderToasts(s);
}

// store.subscribe 驱动渲染（原 React 版顶层 useSyncExternalStore 本来就是全树重渲,
// 这里换成 rAF 批处理 + 各区域签名比对, 等价且不抖输入焦点）
let queued = false;
function scheduleUpdate() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => { queued = false; update(); });
}
subscribe(scheduleUpdate);
update();

/* 启动流程 */
void (async () => {
  try {
    await pullSyncCreds();   // 同步开启时把其它设备的密码合并进来（失败不影响启动）
    await loadState();
    await boot();
  } catch {
    // 无账号/接口失败: 停留在登录页
  }
})();

const applyHash = () => {
  const r = (location.hash || '#/report').replace('#/', '') || 'report';
  if (ALIAS[r] || NAV.some((n) => n.id === r)) go(r);
};
applyHash();
window.addEventListener('hashchange', applyHash);
