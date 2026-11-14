#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""双通道登录：同时在对话里给出「微信扫码」和「APP 扫码」两张二维码。

与 flow_test.py 单通道的区别：
  - 每一轮同时登记两条通道，输出一对 PNG（各自 base64），Agent 用一个 widget 并排内联展示；
  - 轮询时交替查询 checkUUIDStatus（微信）与 loginCheck（APP），任一通道扫到即换凭证；
  - 两条通道都无人扫、且本地计时到点（约 55 秒）时，**同时重取两张码**再输出一轮，
    绝不复用旧 uuid，也不单独只换其中一张。

输出行（供 Agent 逐行消费）：
  DUAL_QR#n|<ttl>|<wechat_uuid>|<app_uuid>|<wechat_b64>|<app_b64>
  WIDGET#n|<html>                     直接作为 show_widget 的 widget_code
  DUAL_EXPIRED#n|reason=...|elapsed=..s
  LOGIN_OK|{"channel":...,"token":{...}}
  RESULT|ok=...|...

只用本人账号登录；不自动播放课程、不绕过平台限制。
"""
from __future__ import annotations

import argparse
import base64
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mooc_api import MoocAuth  # noqa: E402


def log(tag: str, **kw) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {tag} " + json.dumps(kw, ensure_ascii=False), flush=True)


def dual_widget(b64_wx: str, b64_app: str, uid_wx: str, uid_app: str,
                ttl: int, cycle: int) -> str:
    """两张码并排的 widget HTML。图片必须内嵌 base64 —— 本地路径 / file 协议在 widget 里全部失效。"""
    card = (
        '<div style="flex:1 1 210px; min-width:210px; text-align:center; '
        'padding:12px 10px; background:var(--color-background-secondary); '
        'border:0.5px solid var(--color-border-tertiary); border-radius:var(--border-radius-lg);">'
        '<img src="data:image/png;base64,{b64}" alt="{title}" '
        'style="width:180px; height:180px; image-rendering:pixelated; border-radius:6px;">'
        '<p style="margin:10px 0 3px; font-size:14px; font-weight:500; '
        'color:var(--color-text-primary);">{title}</p>'
        '<p style="margin:0; font-size:12px; line-height:1.65; '
        'color:var(--color-text-secondary);">{hint}<br>uuid {uid}</p>'
        '</div>'
    )
    left = card.format(b64=b64_wx, title="微信扫一扫登录",
                       hint="微信 → 右上角「+」→ 扫一扫", uid=uid_wx[:8])
    right = card.format(b64=b64_app, title="APP 扫一扫登录",
                        hint="烟草网络学院 APP → 右上角扫一扫", uid=uid_app[:8])
    # 纯静态 HTML：不要放 <script>。带 JS 的 widget 需要宿主起沙箱渲染管道，
    # 会长时间停在「正在渲染组件」，用户因此错过 1 分钟有效期。有效期用静态文字说明。
    html = (
        '<div style="max-width:640px;">'
        '<div style="display:flex; gap:14px; flex-wrap:wrap;">' + left + right + '</div>'
        '<p style="margin:12px 2px 0; font-size:13px; line-height:1.7; '
        'color:var(--color-text-primary);">两张码<b>同时有效</b>，任选一种扫即可 · '
        '约 ' + str(ttl) + ' 秒内有效 · 过期自动换新码</p>'
        '</div>'
    )
    return " ".join(line.strip() for line in html.splitlines() if line.strip())


def run(key: str, ttl: int, cycles: int, outdir: str, interval: float = 2.0) -> bool:
    mw = MoocAuth(session_key=key)   # 微信通道（独立 session，避免串扰）
    ma = MoocAuth(session_key=key)   # APP 通道

    for cycle in range(1, cycles + 1):
        wx_path = f"{outdir}/qr-dual-wechat-{cycle}.png"
        ap_path = f"{outdir}/qr-dual-app-{cycle}.png"
        _url, png_wx = mw.create_wechat_qr(wx_path)
        png_app = ma.fetch_app_qr(ap_path)
        b64w = base64.b64encode(png_wx).decode()
        b64a = base64.b64encode(png_app).decode()
        uid_w, uid_a = mw.wechat_uuid or "", ma.uuid or ""

        log("DUAL_ISSUED", cycle=cycle, wechat_uuid=uid_w, app_uuid=uid_a,
            wechat_bytes=len(png_wx), app_bytes=len(png_app), ttl=f"~{ttl}s")
        print(f"DUAL_QR#{cycle}|{ttl}|{uid_w}|{uid_a}|{b64w}|{b64a}", flush=True)
        print(f"WIDGET#{cycle}|{dual_widget(b64w, b64a, uid_w, uid_a, ttl, cycle)}",
              flush=True)

        t0 = time.time()
        reason, token, channel = "ttl", None, None
        while time.time() - t0 < ttl:
            # 通道 1：微信（服务端 code=0002 代表失效，但实测基本不返回，仍按 ttl 兜底）
            try:
                d = mw.probe_wechat()
                if d.get("code") == "0002":
                    reason = "wechat_expired"
                    break
                if d.get("status"):
                    resp = mw.wechat_auth(d.get("openId", ""))
                    token = (resp.json() if resp.status_code == 200
                             else {"error": resp.text[:250]})
                    channel, reason = "wechat", "scanned"
                    break
            except Exception as exc:                       # 单次网络抖动不中断整轮
                log("POLL_ERR", ch="wechat", err=str(exc)[:120])

            # 通道 2：APP（未扫码恒为 {}，无任何过期信号）
            try:
                d = ma.probe_app()
                if d:
                    token, channel, reason = d, "app", "scanned"
                    break
            except Exception as exc:
                log("POLL_ERR", ch="app", err=str(exc)[:120])

            time.sleep(interval)

        elapsed = round(time.time() - t0, 1)
        log("DUAL_END", cycle=cycle, reason=reason, elapsed=elapsed, channel=channel)
        if token is not None:
            # 登录成功即落会话，下次使用 skill 时 status 可直接判定有效、免登录
            try:
                from mooc_tasks import save_token_from_login
                saved = save_token_from_login(token, f"qr-{channel}")
                if saved:
                    log("SESSION_SAVED", enc=saved["enc"], expires_at=saved["expires_at"])
            except Exception as exc:
                log("SESSION_SAVE_ERR", err=str(exc)[:120])
            print("LOGIN_OK|" + json.dumps({"channel": channel, "token": token},
                                           ensure_ascii=False)[:700], flush=True)
            print(f"RESULT|ok=True|channel={channel}|cycles={cycle}", flush=True)
            return True

        print(f"DUAL_EXPIRED#{cycle}|reason={reason}|elapsed={elapsed}s", flush=True)

    print(f"RESULT|ok=False|timeout=True|cycles={cycles}", flush=True)
    return False


def main() -> int:
    p = argparse.ArgumentParser(description="同时展示微信码与 APP 码，任一扫到即登录")
    p.add_argument("--key", required=True, help="hashKey（会话 key，APP 轮询与换票需要）")
    p.add_argument("--ttl", type=int, default=55, help="单轮两张码的有效等待秒数")
    p.add_argument("--cycles", type=int, default=3, help="过期自动重取的最大轮数")
    p.add_argument("--interval", type=float, default=2.0, help="轮询间隔秒")
    p.add_argument("--out", default=".", help="二维码落盘目录（须在会话工作区内）")
    a = p.parse_args()
    Path(a.out).mkdir(parents=True, exist_ok=True)
    # 无人扫码属于预期结果，不算脚本失败；结果以 RESULT| 行为准
    run(a.key, a.ttl, a.cycles, a.out, a.interval)
    return 0


if __name__ == "__main__":
    sys.exit(main())
