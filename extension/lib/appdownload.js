/**
 * APP 下载引导（纯逻辑部分, UI 在 console/app.js）: 两个链接常量 + 本地二维码渲染。
 * 从 ext 分支 src/components/AppDownload.tsx 抽出 —— 数据与算法不动, 仅迁移位置。
 */
import qrcode from './vendor/qrcode.js';

export const APP_LINKS = {
  android: 'https://mooc9cdnpro.zhixueyun.com/mooc/zxy_saas_mooc_5.3.7.11.apk',
  harmony: 'https://appgallery.huawei.com/app/detail?id=com.tobacco.StudentApp&channelId=SHARE&source=appshare',
  guide: 'https://mooc.ctt.cn/app/share/#/',
};

/** 生成 data URL 二维码（gif, 与微信登录码同一套渲染方式） */
export function makeQr(text) {
  const qr = qrcode(0, 'Q');
  qr.addData(text);
  qr.make();
  return qr.createDataURL(6, 2);
}
