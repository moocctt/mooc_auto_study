/** 设置页: 账号 / 偏好 / 关于与隐私 三个 tab。
 *  移植自 src/components/{Settings,Accounts}.tsx。 */
import { getState, setState, confirmAction, toast, go } from '../../lib/store.js';
import { STORE } from '../../lib/flags.js';
import {
  downloadCalendar, exportBackup, importBackup, setSettings,
  openPlatformLoggedIn, removeAccount, switchAccount, tokenStatusOf, clearCreds,
} from '../../lib/actions.js';
import { getProfile, setProfile } from '../../lib/today.js';
import { setSyncEnabled, syncEnabled, syncSupported } from '../../lib/vault.js';
import { setSfxEnabled, sfxEnabled } from '../../lib/sfx.js';
import { initials } from '../../lib/core.js';
import { prefillForAccount } from '../../lib/loginEntry.js';
import { openLogin } from '../../lib/store.js';
import { el, icon, pill, button } from '../ui.js';

const TABS = [['accounts', '账号'], ['prefs', '偏好'], ['about', '关于与隐私']];

const MODES = [
  ['auto', '自动（推荐）', '有音轨走音频，否则走视频，行为最接近 App'],
  ['audio', '仅音频', '只用 mp3 转码音轨，单档 300s'],
  ['video', '仅视频', '只用 mp4，单档 600s'],
];

export function renderSettings(host, s) {
  const tab = TABS.some(([v]) => v === s.settingsTab) ? s.settingsTab : 'accounts';
  if (host.dataset.sig === tab) return;
  host.dataset.sig = tab;
  const tabs = el('div', { class: 'tabs', role: 'tablist' });
  for (const [v, label] of TABS) {
    const b = el('button', { class: 'tab', role: 'tab', 'aria-selected': String(tab === v), text: label });
    b.addEventListener('click', () => setState({ settingsTab: v }));
    tabs.append(b);
  }
  const body = el('div', {});
  host.replaceChildren(el('div', { class: 'stack' }, tabs, body));
  if (tab === 'accounts') renderAccounts(body, s);
  else if (tab === 'about') renderAbout(body);
  else renderPrefs(body, s);
}

/* ── 账号管理 ──────────────────────────────────────────── */
function renderAccounts(host, s) {
  const sig = JSON.stringify(s.accounts);
  if (host.dataset.sig === sig) return;
  host.dataset.sig = sig;
  const grid = el('div', { class: 'acc-grid' });
  for (const a of s.accounts) {
    const name = a.displayName || a.username;
    const st = tokenStatusOf(a.key);
    const statusCls = st?.kind === 'err' ? 'err' : st?.kind === 'warn' ? 'warn' : '';
    grid.append(el('article', { class: 'acc-card' },
      el('div', { class: 'acc-head' },
        el('span', { class: 'acc-avatar', text: initials(name) }),
        el('div', { style: { minWidth: 0 } },
          el('div', { class: 'acc-name', text: name }),
          el('div', { class: 'acc-sub', text: a.displayName ? a.username : '平台账号' }),
          st ? el('div', { class: `acc-status ${statusCls}`, title: st.label, text: st.label }) : '',
        ),
        a.active ? el('span', { class: 'acc-active' }, pill('ok', '', '当前')) : '',
      ),
      el('div', { class: 'acc-actions' },
        st?.kind === 'err'
          // 失效账号: 主按钮直接是「重新登录」→ 打开扩展自己的登录页（账密账号预填手机号）
          ? button('primary', { onclick: () => openLogin(prefillForAccount(a)) }, '重新登录')
          : a.active
            ? button('default', { disabled: true }, '已选用')
            : button('primary', { onclick: () => void switchAccount(a.key) }, '切换到此账号'),
        a.active && st?.kind !== 'err'
          ? button('default', { title: '用当前登录态打开平台官网（免再次登录）', onclick: () => void openPlatformLoggedIn() }, '官网')
          : '',
        button('danger', {
          class: 'icon-only', title: '移除账号',
          onclick: () => confirmAction('移除账号', `从本会话移除 ${name}？`, '移除', () => { void removeAccount(a.key); }),
        }, icon('trash', 'ic14')),
      ),
    ));
  }
  const add = el('button', { class: 'acc-add' }, icon('plus', 'ic24'), el('span', { text: '添加平台账号' }));
  add.addEventListener('click', () => openLogin());
  grid.append(add);
  host.replaceChildren(el('div', { class: 'stack' },
    grid,
    el('p', { class: 'acc-note', text: '多个账号互不影响：每个浏览器会话各自保存自己的账号，切换只影响当前会话。' }),
  ));
}

/* ── 关于与隐私 ────────────────────────────────────────── */
function renderAbout(host) {
  let ver = 'dev';
  try { ver = chrome.runtime.getManifest().version; } catch { /* 非扩展环境 */ }
  const link = el('a', {
    href: 'https://github.com/gandli/tobacco-mooc-study',
    target: '_blank', rel: 'noopener noreferrer',
    style: { color: 'var(--brand)' },
  }, 'github.com/gandli/tobacco-mooc-study');
  host.replaceChildren(el('div', { class: 'stack' },
    el('section', { class: 'card card-pad' },
      el('h2', { style: { marginBottom: '8px', color: 'var(--ink)', fontSize: '15px' }, text: '关于' }),
      el('p', { style: { margin: 0, fontSize: '14px', color: 'var(--ink2)' }, text: `烟草网络学院学习助手 v${ver}` }),
      el('p', { style: { margin: '4px 0 0', fontSize: '12px', color: 'var(--muted)' }, text: '非官方扩展，与学习平台及其运营方无关联；仅用于查看本人账号的学习进度与提醒。' }),
      el('p', { style: { margin: '8px 0 0', fontSize: '12px', color: 'var(--muted)' } }, '源代码与问题反馈：', link),
    ),
    el('section', { class: 'card card-pad' },
      el('h2', { style: { marginBottom: '8px', color: 'var(--ink)', fontSize: '15px' }, text: '隐私与数据' }),
      el('ul', { class: 'about-list' },
        el('li', {}, '· 数据全部保存在本机浏览器（扩展存储/localStorage），', el('b', {}, '不上传任何自有服务器，不出售、不共享')),
        el('li', { text: '· 账号密码仅在你勾选「记住凭据」时保存到本机扩展存储，用于登录态到期前自动续期（有效期由平台按登录方式下发）；未勾选时只存当前标签页会话' }),
        el('li', { text: '· 开启「凭据同步」后密码副本经浏览器内置同步在你的设备间共享（令牌不同步）；关闭即删除云端副本' }),
        el('li', { text: '· 与平台的通信仅用于读取你的学时/任务/小节进度（host 权限：mooc.ctt.cn）' }),
        el('li', { text: '· 卸载扩展或点击下方「清除本机数据」即可删除全部本地数据' }),
        el('li', {}, '· 完整说明见仓库 ', el('code', {}, 'PRIVACY.md'), ' 与商店隐私政策页'),
      ),
    ),
    el('section', { class: 'card card-pad' },
      el('h2', { style: { marginBottom: '8px', color: 'var(--ink)', fontSize: '15px' }, text: '清除本机数据' }),
      el('p', { class: 'clear-note', text: '删除保存的凭据/令牌与本地数据（不影响平台上的学习记录）。' }),
      el('div', { style: { marginTop: '12px' } },
        button('danger', {
          onclick: () => confirmAction('清除本机数据',
            '将删除本机保存的凭据、令牌与本地数据（不影响平台上的学习记录），清除后需重新登录。',
            '清除', () => {
              void clearCreds();
              try { localStorage.clear(); sessionStorage.clear(); } catch { /* 忽略 */ }
              location.reload();
            }),
        }, '清除本机数据'),
      ),
    ),
  ));
}

/* ── 偏好 ──────────────────────────────────────────────── */
let sfxOn = sfxEnabled();

function renderPrefs(host, s) {
  host.classList.add('settings-prefs-host');
  const sig = JSON.stringify([s.mode, s.unlocked, s.accounts.map((a) => [a.key, a.active, a.displayName, a.username])]);
  if (host.dataset.sig === sig) return;
  host.dataset.sig = sig;

  const root = el('div', { class: 'stack' });

  if (!STORE) {
    if (!s.unlocked) {
      root.append(el('section', { class: 'locked-note' },
        el('h2', { text: '自动化设置' }),
        el('p', { text: '下面是当前生效的默认值；完整功能解锁后可修改（学习模式 / 日历订阅）。' }),
      ));
    }
    root.append(el('section', { class: 'card card-pad' },
      el('h2', { style: { marginBottom: '12px', color: 'var(--ink)', fontSize: '15px' }, text: '学习模式' }),
      el('div', { class: 'mode-grid' }, MODES.map(([value, title, desc]) => {
        const input = el('input', { type: 'radio', name: 'mode', value, disabled: !s.unlocked ? true : undefined });
        if (s.mode === value) input.checked = true;
        input.addEventListener('change', () => { if (input.checked) void setSettings({ mode: value }); });
        return el('label', {
          class: `mode-item ${s.mode === value ? 'checked' : ''} ${s.unlocked ? 'enabled' : ''}`,
        }, input, el('div', {}, el('strong', { text: title }), el('span', { class: 'desc', text: desc })));
      })),
    ));
    const dn = s.accounts.find((a) => a.active);
    const displayName = dn ? (dn.displayName || dn.username) : '未登录';
    root.append(el('section', { class: 'card card-pad' },
      el('h2', { style: { marginBottom: '4px', color: 'var(--ink)', fontSize: '15px' }, text: '执行策略' }),
      el('div', { class: 'pref-line' },
        el('div', {}, el('strong', { text: '当前账号' }), el('span', { class: 'desc', text: displayName })),
        button('default', { onclick: () => go('accounts') }, '管理账号'),
      ),
      el('div', { class: 'pref-line' },
        el('div', {}, el('strong', { text: '日历订阅' }), el('span', { class: 'desc', text: '导出必修任务截止日（.ics，默认脱敏，可导入手机日历）。' })),
        button('default', { disabled: !s.unlocked ? true : undefined, onclick: () => void downloadCalendar() }, '下载日历'),
      ),
    ));
  }

  root.append(syncCard());
  if (!STORE) {
    const sfxCheck = el('input', { type: 'checkbox' });
    sfxCheck.checked = sfxOn;
    sfxCheck.addEventListener('change', () => { setSfxEnabled(sfxCheck.checked); sfxOn = sfxCheck.checked; state.textContent = sfxOn ? '已开启' : '已关闭'; });
    const state = el('span', { class: 'pref-toggle-state', style: { fontSize: '13px', color: 'var(--ink2)' }, text: sfxOn ? '已开启' : '已关闭' });
    root.append(el('section', { class: 'sfx-card' },
      el('div', { style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px' } },
        el('h2', { style: { margin: 0, color: 'var(--ink)', fontSize: '15px' }, text: '提示音' }),
        el('label', { class: 'pref-toggle' }, sfxCheck, state),
      ),
      el('p', { class: 'sfx-note', text: '任务完成、失败等结果用两声短音提示（正弦波合成，无音频文件）；不会为普通点击发声。' }),
    ));
  }
  root.append(el('section', { class: 'card card-pad' },
    el('h2', { style: { marginBottom: '4px', color: 'var(--ink)', fontSize: '15px' }, text: '今日学习额度' }),
    el('p', { style: { margin: '0 0 12px', fontSize: '12px', color: 'var(--muted)' }, text: '每天最多学多少学时（用于「今日已学 / 额度」）：工作日与周末可分别设置。' }),
    capacityForm(),
  ));
  root.append(backupCard(), securityCard());
  host.replaceChildren(root);
}

/* 凭据同步: 把勾选「记住凭据」保存的密码镜像到浏览器内置同步 */
let syncState = null; // { on, err, busy }

function rerenderPrefs() {
  const body = document.querySelector('.settings-prefs-host');
  if (body) renderPrefs(body, getState());
}

function syncCard() {
  const supported = syncSupported();
  if (!syncState) syncState = { on: supported ? null : false, err: '', busy: false };
  if (supported && syncState.on === null) {
    void syncEnabled().then((v) => { syncState.on = v; rerenderPrefs(); }).catch(() => { syncState.on = false; rerenderPrefs(); });
  }
  if (syncState.on === null) return el('div');
  const card = el('section', { class: 'sync-card' });
  const check = el('input', { type: 'checkbox', disabled: !supported || syncState.busy ? true : undefined });
  check.checked = syncState.on;
  const state = el('span', { style: { fontSize: '13px', color: 'var(--ink2)' }, text: syncState.busy ? '处理中…' : syncState.on ? '已开启' : '已关闭' });
  check.addEventListener('change', () => {
    const next = check.checked;
    syncState.busy = true; syncState.err = '';
    void setSyncEnabled(next)
      .then(() => { syncState.on = next; })
      .catch((x) => { syncState.err = String(x?.message || x); })
      .finally(() => { syncState.busy = false; rerenderPrefs(); });
  });
  card.append(
    el('div', { style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px' } },
      el('h2', { style: { margin: 0, color: 'var(--ink)', fontSize: '15px' }, text: '凭据同步' }),
      el('label', { class: 'pref-toggle' }, check, state),
    ),
    el('p', { style: { margin: '8px 0 0', fontSize: '13px', lineHeight: 1.6, color: 'var(--ink2)' } },
      '勾选「记住凭据」保存的密码会经浏览器内置同步（Chrome/Edge 账号）在你的其它设备间共享；',
      el('b', { style: { fontWeight: 600, color: 'var(--ink)' } }, '登录令牌不同步'),
      '，每台设备各自维护。'),
    el('p', { style: { margin: '4px 0 0', fontSize: '13px', lineHeight: 1.6, color: 'var(--ink2)' } },
      !supported ? '当前浏览器不支持同步存储。' : '',
      supported && syncState.on ? '已开启：密码随浏览器账号同步，关闭时云端副本一并删除。' : '',
      supported && !syncState.on ? '已关闭：密码只保存在本机。' : '',
      syncState.err ? el('span', { class: 'sync-err', text: syncState.err }) : '',
    ),
    el('p', { style: { margin: '8px 0 0', fontSize: '12px', lineHeight: 1.6, color: 'var(--muted)' }, text: '共享设备或公共电脑请保持关闭；同步内容是明文密码，安全性取决于你的浏览器账号。' }),
  );
  return card;
}

/* 工作档位（今日学习额度）编辑: 输入框只建一次, 重渲染时复用同一节点（不丢未保存值） */
let capacityEl = null;

function capacityForm() {
  if (capacityEl) return capacityEl;
  const prof = getProfile();
  const wd = el('input', { type: 'number', min: 0, step: 0.5, value: String(prof.weekday_hours ?? 2) });
  const we = el('input', { type: 'number', min: 0, step: 0.5, value: String(prof.weekend_hours ?? 4) });
  capacityEl = el('div', { class: 'capacity-form' },
    el('label', {}, '工作日（小时）', wd),
    el('label', {}, '周末（小时）', we),
    button('default', {
      onclick: () => {
        const wdv = Number(wd.value); const wev = Number(we.value);
        if (!Number.isFinite(wdv) || !Number.isFinite(wev) || wdv < 0 || wev < 0) { toast('学习额度需为非负数字', 'err'); return; }
        setProfile({ weekday_hours: wdv, weekend_hours: wev });
        toast('学习额度已保存', 'ok');
      },
    }, '保存'),
  );
  return capacityEl;
}

function backupCard() {
  const fileInput = el('input', { type: 'file', accept: 'application/json,.json' });
  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    if (f) {
      void (async () => {
        try { await importBackup(await f.text()); } catch { /* 文件读不出来: 由 importBackup 的提示兜底 */ }
      })();
    }
    fileInput.value = '';
  });
  return el('section', { class: 'card card-pad' },
    el('h2', { style: { marginBottom: '4px', color: 'var(--ink)', fontSize: '15px' }, text: '数据备份' }),
    el('p', { style: { margin: '0 0 12px', fontSize: '12px', color: 'var(--muted)' } },
      '导出/导入账号名、运行记录与当日账本；', el('b', {}, '不含密码与 token'), '，换浏览器或重装后可恢复历史。'),
    el('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px' } },
      button('default', { onclick: () => void exportBackup() }, '导出备份'),
      el('label', { class: 'file-btn' }, '导入备份', fileInput),
    ),
  );
}

function securityCard() {
  return el('section', { class: 'card card-pad' },
    el('h2', { style: { marginBottom: '8px', color: 'var(--ink)', fontSize: '15px' }, text: '数据与安全' }),
    el('ul', { class: 'security-list' },
      el('li', { text: '· 账号、模式、运行记录、token（有效期由平台下发）存浏览器 localStorage；密码仅在你勾选「记住凭据」时存入扩展存储，未勾选时只存当前标签页会话（关闭标签页即清除）' }),
      el('li', { text: '· 请求由扩展直连学院平台，不经过任何自有服务器' }),
      el('li', { text: '· token 到期后用保存的密码自动续期（仅限勾选「记住凭据」且用账号密码登录的账号）；扫码登录的账号到期需重新扫码' }),
    ),
  );
}
