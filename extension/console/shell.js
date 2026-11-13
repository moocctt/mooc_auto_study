/** 应用外壳: 侧栏导航 + 顶栏（含登录墙横幅、移动端导航）。移植自 src/components/Shell.tsx */
import { NAV, go, openLog, openLogin } from '../lib/store.js';
import { STORE } from '../lib/flags.js';
import { forceRefreshAll, dismissNeedLogin, logout, openPlatformHome } from '../lib/actions.js';
import { prefillForAccount } from '../lib/loginEntry.js';
import { wallBannerVisible } from '../lib/needLogin.js';
import { initials } from '../lib/core.js';
import { el, icon, pill } from './ui.js';

/* 头像加载失败的 URL 记住一次, 避免重建侧栏时反复闪原图（对齐 React 的 failed state） */
const failedAvatars = new Set();

function accountAvatar(acc) {
  const name = acc ? (acc.displayName || acc.username) : '?';
  if (acc?.avatar && !failedAvatars.has(acc.avatar)) {
    const img = el('img', { src: acc.avatar, alt: name, title: name, class: 'avatar' });
    img.addEventListener('error', () => { failedAvatars.add(acc.avatar); img.replaceWith(accountAvatar(acc)); });
    return img;
  }
  return el('span', { class: 'avatar', title: name, text: initials(name) });
}

let collapsed = (() => { try { return localStorage.getItem('mooc.console.sidebar') === '1'; } catch { return false; } })();

function toggleSidebar(rerender) {
  collapsed = !collapsed;
  try { localStorage.setItem('mooc.console.sidebar', collapsed ? '1' : '0'); } catch { /* 忽略 */ }
  rerender();
}

export function renderSidebar(host, s) {
  const acc = s.accounts.find((a) => a.active) || null;
  const undone = s.rows.filter((r) => r.runnable && r.state !== '已完成' && r.state !== '已过期').length;
  const accSig = JSON.stringify(s.accounts.map((a) => [a.key, a.active, a.avatar, a.displayName, a.username]));
  const sig = `${s.route}|${s.unlocked}|${collapsed}|${accSig}|${undone}`;
  if (host.dataset.sig === sig) return;
  host.dataset.sig = sig;

  const nav = el('nav', { class: 'side-nav' });
  for (const item of NAV) {
    const badge = item.id === 'tasks' && !!undone
      ? (collapsed
        ? el('span', { class: 'side-dot anim-pop' })
        : el('span', { class: 'side-badge anim-pop', text: String(undone) }))
      : '';
    nav.append(el('a', {
      href: `#/${item.id}`, title: collapsed ? item.label : undefined,
      class: `side-link ${s.route === item.id ? 'active' : ''}`,
      onclick: (e) => { e.preventDefault(); go(item.id); },
    }, icon(item.icon, 'ic16'), collapsed ? '' : item.label, badge));
  }

  const foot = el('div', { class: 'side-foot' });
  if (collapsed) {
    foot.append(
      el('button', { class: 'btn', style: { border: '0', background: 'none' }, title: acc ? (acc.displayName || acc.username) : '未添加账号', onclick: () => go('accounts') }, accountAvatar(acc)),
      el('button', { class: 'btn btn-logout', title: '登出', 'aria-label': '登出', onclick: () => void logout() }, icon('logout', 'ic14')),
    );
  } else {
    foot.append(
      el('div', { class: 'side-account' },
        accountAvatar(acc),
        el('div', {},
          el('strong', { text: acc ? (acc.displayName || acc.username) : '未添加账号' }),
          el('small', { text: acc ? (acc.displayName ? acc.username : '平台账号') : '请先添加账号' }),
        ),
      ),
      el('div', { class: 'side-actions' },
        el('button', { class: 'btn', text: '切换账号', onclick: () => go('accounts') }),
        el('button', { class: 'btn btn-logout', title: '登出', onclick: () => void logout() }, icon('logout', 'ic14')),
      ),
    );
  }

  host.replaceChildren(el('aside', {
    class: `sidebar ${collapsed ? 'collapsed' : ''}`,
  },
    el('div', { class: 'sidebar-head' },
      el('img', { src: '/icon/32.png', alt: '', width: 32, height: 32, title: '烟草网络学院学习助手' }),
      collapsed ? '' : el('div', { class: 'sidebar-brand' },
        el('strong', { text: '烟草网络学院' }),
        el('small', { text: '学习助手' }),
      ),
      el('button', {
        class: 'side-toggle', title: collapsed ? '展开侧栏' : '收起侧栏',
        'aria-label': collapsed ? '展开侧栏' : '收起侧栏', 'aria-expanded': String(!collapsed),
        onclick: () => toggleSidebar(() => renderSidebar(host, { ...s, __force: Date.now() })),
      }, icon(collapsed ? 'chevron-right' : 'chevron-left', 'ic16')),
    ),
    nav,
    foot,
  ));
}

const short = (str, n) => (str.length > n ? `${str.slice(0, n)}……` : str);

export function renderTopbar(host, s) {
  const acc = s.accounts.find((a) => a.active);
  const wallAcc = s.needLogin?.account ? s.accounts.find((a) => a.key === s.needLogin.account) : null;
  const wallWho = wallAcc ? `${wallAcc.displayName || wallAcc.username} ` : '';
  const item = NAV.find((n) => n.id === s.route) || NAV[0];
  const ctx = s.ap.ctx || {};
  const apTip = [ctx.subjectName || (ctx.subjectId ? `专题 ${ctx.subjectId.slice(0, 8)}` : ''), ctx.video]
    .filter(Boolean).join(' › ');
  const showBanner = wallBannerVisible(s.needLogin, acc?.key || '', s.accounts.map((a) => a.key)) && !!s.needLogin;
  const sig = JSON.stringify([s.route, s.busy, s.ap.on, s.ap.status, apTip, showBanner, s.needLogin?.at, s.needLogin?.why, s.needLogin?.account, wallWho, s.accounts.map((a) => [a.key, a.active, a.displayName, a.username])]);
  if (host.dataset.sig === sig) return;
  host.dataset.sig = sig;

  // 值守状态: 名称过长省略, 详情放 tooltip; 点击打开运行日志
  const apBtn = s.ap.on ? el('button', {
    class: 'ap-pill', onclick: () => openLog(),
    title: apTip ? `${apTip}\n${s.ap.status}` : (s.ap.status || '自动学习值守中'),
    'aria-label': '自动学习值守中, 点击查看运行日志',
  }, pill('ok', '', el('span', { class: 'ping-wrap' }), el('span', {
    style: { overflow: 'hidden', 'text-overflow': 'ellipsis' },
    text: ctx.video ? `${short(ctx.video, 10)} ${short(s.ap.status, 18)}` : short(s.ap.status || '值守中', 20),
  }))) : '';

  const logBtn = !STORE ? el('button', {
    class: 'icon-btn', title: '运行日志', 'aria-label': '运行日志', onclick: () => openLog(),
  }, icon('pulse', 'ic16'), s.busy ? el('span', { class: 'busy-dot' }) : '') : '';

  const refreshBtn = s.route === 'tasks' ? el('button', {
    class: 'btn', onclick: () => void forceRefreshAll(),
  }, icon('refresh', 'ic14'), ' 刷新') : '';

  const avatarMini = el('button', { class: 'avatar-mini', title: '账号管理', onclick: () => go('accounts') },
    initials(acc ? (acc.displayName || acc.username) : '+'));
  const statusPill = s.busy ? pill('warn', '', el('span', { class: 'dot' }), `运行中 · ${s.busy}`)
    : '';

  const banner = showBanner ? el('div', { class: 'wall-banner', role: 'alert' },
    el('span', { class: 'icon' }, icon('alert', 'ic16')),
    el('span', { class: 'msg', text: `${wallWho}登录态已失效（${s.needLogin.why || '平台拒绝访问'}）· 重新登录（账号密码 / 扫码）或导入官网登录态后可继续` }),
    el('button', { class: 'btn btn-wall', onclick: () => openLogin(prefillForAccount(wallAcc)) },
      wallAcc ? `重新登录 ${wallAcc.displayName || wallAcc.username}` : '重新登录'),
    el('button', {
      class: 'btn btn-wall2', title: '在官网自己登录一次，登录态会自动导入扩展',
      onclick: () => void openPlatformHome(),
    }, '去官网登录'),
    el('button', {
      class: 'dismiss', title: '忽略本次提示（下次撞到登录墙会再提示）', 'aria-label': '忽略登录失效提示',
      onclick: () => void dismissNeedLogin(),
    }, icon('x', 'ic14')),
  ) : '';

  const mobileNav = el('nav', { class: 'mobile-nav', 'aria-label': '页面导航' });
  for (const n of NAV) {
    mobileNav.append(el('a', {
      href: `#/${n.id}`, class: s.route === n.id ? 'active' : '',
      onclick: (e) => { e.preventDefault(); go(n.id); },
    }, n.label));
  }

  host.replaceChildren(
    el('header', { class: 'topbar' },
      el('div', {}, el('h1', { text: item.title }), el('p', { class: 'topbar-sub', text: item.sub })),
      el('div', { class: 'topbar-actions' }, apBtn, logBtn, refreshBtn, avatarMini, statusPill),
    ),
    banner,
    mobileNav,
  );
}
