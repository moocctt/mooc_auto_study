/**
 * chrome-devtools MCP 配置自检
 * ============================
 * 用 ~/.workbuddy/mcp.json 里 `chrome-devtools` 的真实配置拉起一个 MCP 实例，
 * 走 MCP 协议（stdio，换行分隔 JSON-RPC）调 list_pages / evaluate_script，
 * 验证「配置 + scripts/dev-chrome.sh 的 9223 浏览器」这条路是通的。
 *
 * 为什么需要它：MCP 服务进程是启动时一次性读配置的，改了 mcp.json 不会热加载；
 * 宿主里那个实例可能还是旧参数。这个脚本能立刻回答「配置对不对」，
 * 而不用等重开会话才发现少了个 flag。
 *
 * 用法: npm run mcp:verify   （前提：npm run dev 已把 Chrome 起在 9223）
 * 退出码: 0 = 扩展页可见且能执行脚本; 1 = 不通（会打印具体原因）
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MCP_JSON = join(homedir(), '.workbuddy', 'mcp.json');
const NAME = process.env.MCP_NAME || 'chrome-devtools';

const cfg = JSON.parse(readFileSync(MCP_JSON, 'utf8'));
const server = cfg?.mcpServers?.[NAME];
if (!server) {
  console.error(`✗ ${MCP_JSON} 里没有 mcpServers.${NAME}`);
  process.exit(1);
}
const { command, args = [] } = server;
console.log(`› 启动: ${command} ${args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`);

const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '';
const pending = new Map();
child.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  }
});
const stderrLines = [];
child.stderr.on('data', (d) => stderrLines.push(...String(d).split('\n').filter(Boolean)));

const rpc = (method, params = {}, timeoutMs = 30000) => new Promise((res, rej) => {
  const id = Math.floor(Math.random() * 1e9);
  pending.set(id, res);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error(`${method} 超时`)); } }, timeoutMs);
});
const note = (method, params = {}) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');

const textOf = (r) => r?.result?.content?.map((c) => c.text).join('\n') || JSON.stringify(r).slice(0, 500);
const done = (code) => { try { child.kill(); } catch { /* 忽略 */ } setTimeout(() => process.exit(code), 200); };

try {
  await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'mcp-verify', version: '1.0.0' },
  });
  note('notifications/initialized');

  const pages = await rpc('tools/call', { name: 'list_pages', arguments: {} });
  const text = textOf(pages);
  console.log('› list_pages:\n' + text);

  if (/Could not connect to Chrome|ECONNREFUSED|Failed to fetch browser webSocket URL/.test(text)) {
    console.error('\n✗ 连不上浏览器：先 npm run dev（Chrome 应监听 9223）；或 mcp.json 里缺 --browserUrl。');
    done(1);
  } else if (!text.includes('chrome-extension://')) {
    console.error('\n✗ 看见了浏览器，但看不到扩展页 —— mcp.json 里缺 --categoryExtensions（默认会过滤 chrome-extension://）。');
    done(1);
  } else {
    const line = text.split('\n').find((l) => /^\d+:/.test(l) && l.includes('chrome-extension://'));
    const id = Number(/^(\d+):/.exec(line || '')?.[1]);
    const r = await rpc('tools/call', {
      name: 'evaluate_script',
      arguments: {
        pageId: id,
        function: `async () => {
          const s = await chrome.storage.local.get(['mooc.vault.tokens', 'mooc.needLogin']);
          return {
            accounts: Object.keys(s['mooc.vault.tokens'] || {}),
            needLogin: !!s['mooc.needLogin'],
            title: await chrome.action.getTitle({}),
          };
        }`,
      },
    });
    console.log('› evaluate_script(扩展页):\n' + textOf(r));
    const ok = /accounts|title/.test(textOf(r));
    console.log(ok ? '\n✓ MCP 已附着到 scripts/dev-chrome.sh 的浏览器，可在扩展页执行脚本' : '\n✗ 能连上但执行脚本失败');
    done(ok ? 0 : 1);
  }
} catch (e) {
  console.error(`✗ ${e.message}`);
  if (stderrLines.length) console.error('  stderr: ' + stderrLines.slice(-3).join(' | ').slice(0, 400));
  done(1);
}
