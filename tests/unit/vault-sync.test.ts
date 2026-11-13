// @ts-nocheck —— 测试桩大量动态结构, 类型检查豁免
/** 凭据同步: setSyncEnabled 推送/清除云端密码; putCred 镜像; pullSyncCreds 合并; 令牌不同步 */
import assert from 'node:assert/strict';
import { test, beforeEach } from 'vitest';

function memArea() {
  const m = new Map();
  return {
    _m: m,
    async get(k) { const key = String(k); return m.has(key) ? { [key]: m.get(key) } : {}; },
    async set(items) { for (const [k, v] of Object.entries(items)) m.set(k, v); },
    async remove(k) { m.delete(String(k)); },
  };
}

const local = memArea();
const sync = memArea();
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.chrome = { storage: { local, sync } };

const P = 'mooc.vault.';
const { allCreds, clearVault, dropCred, putCred, pullSyncCreds, setSyncEnabled, syncEnabled, syncSupported } =
  await import('../../extension/lib/vault.js');

beforeEach(async () => { local._m.clear(); sync._m.clear(); });

test('syncSupported: 存在 storage.sync 时为真', () => {
  assert.equal(syncSupported(), true);
});

test('开启同步: 推送已有密码 + 写入开关', async () => {
  await putCred('u1', 'pw1');                      // 同步未开启 → 只写本机
  assert.equal(sync._m.has(P + 'creds'), false);
  await setSyncEnabled(true);
  assert.equal(await syncEnabled(), true);
  assert.deepEqual(sync._m.get(P + 'creds'), { u1: 'pw1' });
});

test('putCred/dropCred 在同步开启时镜像到云端', async () => {
  await setSyncEnabled(true);
  await putCred('u2', 'pw2');
  assert.deepEqual(sync._m.get(P + 'creds'), { u2: 'pw2' });
  await dropCred('u2');
  assert.deepEqual(sync._m.get(P + 'creds'), {});
});

test('pullSyncCreds: 云端密码合并进本机（云端覆盖同名键）', async () => {
  await putCred('local-only', 'a');
  await setSyncEnabled(true);
  sync._m.set(P + 'creds', { remote: 'b', 'local-only': 'remote-wins' });
  const n = await pullSyncCreds();
  assert.equal(n, 2);
  assert.deepEqual(await allCreds(), { 'local-only': 'remote-wins', remote: 'b' });
});

test('关闭同步: 云端密码与开关一并删除, 本机保留', async () => {
  await setSyncEnabled(true);
  await putCred('u3', 'pw3');
  await setSyncEnabled(false);
  assert.equal(await syncEnabled(), false);
  assert.equal(sync._m.has(P + 'creds'), false);
  assert.equal(sync._m.has(P + 'syncEnabled'), false);
  assert.deepEqual(await allCreds(), { u3: 'pw3' });
});

test('clearVault: 同步开启时云端也清空, 令牌始终不同步', async () => {
  await setSyncEnabled(true);
  await putCred('u4', 'pw4');
  // 直接写一个令牌, 验证不会被同步
  const tokens = (await import('../../extension/lib/vault.js'));
  await tokens.putToken('u4', { access_token: 't', expires_in: 60 });
  assert.equal(sync._m.has(P + 'tokens'), false);
  await clearVault();
  assert.deepEqual(sync._m.get(P + 'creds'), {});
  assert.deepEqual(await allCreds(), {});
});
