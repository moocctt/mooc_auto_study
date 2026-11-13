// @ts-nocheck —— 测试桩动态结构, 类型检查豁免
/** APP 下载入口: 两个链接常量 + 本地二维码渲染（同输入同输出, 不同输入不同码） */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { APP_LINKS, makeQr } from '../../extension/lib/appdownload.js';

test('下载链接: Android APK 与华为应用市场, 另有官方引导页', () => {
  assert.match(APP_LINKS.android, /\.apk$/);
  assert.match(APP_LINKS.harmony, /appgallery\.huawei\.com\/app\/detail\?id=com\.tobacco\.StudentApp/);
  assert.equal(APP_LINKS.guide, 'https://mooc.ctt.cn/app/share/#/');
});

test('二维码本地生成: gif data URL, 同输入稳定, 不同输入不同', () => {
  const a1 = makeQr(APP_LINKS.android);
  const a2 = makeQr(APP_LINKS.android);
  const h = makeQr(APP_LINKS.harmony);
  assert.match(a1, /^data:image\/gif;base64,/);
  assert.equal(a1, a2, '同 URL 必须得到同一张码');
  assert.notEqual(a1, h, '两个通道的码不能相同');
});
