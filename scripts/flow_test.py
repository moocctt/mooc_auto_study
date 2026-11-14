#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""两条扫码链路的端到端实测：取码 -> 轮询 -> 换凭证。

用法：
    python flow_test.py wechat --key <hashKey> --seconds 90 --out wx.png
    python flow_test.py app    --key <hashKey> --seconds 90 --out app.png

输出为逐行 STEP 日志（带时间戳），便于后台运行后回读。
"""
from __future__ import annotations

import argparse
import base64
import json
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mooc_api import API, ORG_ID, MoocAuth, aes_encrypt  # noqa: E402


def log(tag: str, **kw) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {tag} " + json.dumps(kw, ensure_ascii=False), flush=True)


def _auto_save(token, channel: str = "wechat") -> None:
    """登录成功后自动落会话，供 status 下次直接判定有效。失败不影响主流程。

    channel 决定会话的端归属（qr-wechat / qr-app）：平台按端单会话，写错端会误判 401。
    """
    try:
        from mooc_tasks import save_token_from_login
        saved = save_token_from_login(token, f"qr-{channel}")
        if saved:
            log("SESSION_SAVED", enc=saved["enc"], expires_at=saved["expires_at"])
    except Exception as exc:
        log("SESSION_SAVE_ERR", err=str(exc)[:120])


def _json_or_empty(text: str):
    try:
        return json.loads(text)
    except ValueError:
        return {}


def run_wechat(m: MoocAuth, seconds: int, out: str) -> dict:
    url, png = m.create_wechat_qr(out)
    log("STEP1_QR", channel="wechat", uuid=m.wechat_uuid, url=url,
        file=out, bytes=len(png), ttl=f"~{seconds}s")

    t0 = time.time()
    n = 0
    while time.time() - t0 < seconds:
        n += 1
        r = m.s.post(API + "/checkUUIDStatus",
                     params={"uuid": m.wechat_uuid}, timeout=m.timeout)
        body = r.text.strip()
        log(f"POLL{n}", http=r.status_code, body=body[:160])

        if body and body not in ("{}", "null"):
            data = _json_or_empty(body)
            if data.get("status"):
                log("SCANNED", openId=data.get("openId"))
                resp = m.wechat_auth(data.get("openId", ""))
                log("STEP3_TOKEN", http=resp.status_code, body=resp.text[:400])
                return {"ok": resp.status_code == 200, "kind": "wechat",
                        "token": _json_or_empty(resp.text) or resp.text[:400]}
            if data.get("code") == "0002":
                log("EXPIRED", code="0002")
                return {"ok": False, "kind": "wechat", "expired": True}
        time.sleep(2)

    log("TIMEOUT", polls=n)
    return {"ok": False, "kind": "wechat", "timeout": True}


def run_app(m: MoocAuth, seconds: int, out: str) -> dict:
    png = m.fetch_app_qr(out)
    log("STEP1_QR", channel="app", uuid=m.uuid, file=out, bytes=len(png),
        ttl=f"~{seconds}s")

    t0 = time.time()
    n = 0
    while time.time() - t0 < seconds:
        n += 1
        r = m.s.get(API + "/loginCheck",
                    params={"uuid": aes_encrypt(m.uuid),
                            "organizationId": aes_encrypt(ORG_ID),
                            "key": m.session_key},
                    timeout=m.timeout)
        body = r.text.strip()
        log(f"POLL{n}", http=r.status_code, body=body[:200])
        if body and body not in ("{}", "null"):
            data = _json_or_empty(body) or {"raw": body[:300]}
            log("STEP3_TOKEN", http=r.status_code,
                body=json.dumps(data, ensure_ascii=False)[:400])
            return {"ok": r.status_code == 200, "kind": "app", "token": data}
        time.sleep(2)

    log("TIMEOUT", polls=n)
    return {"ok": False, "kind": "app", "timeout": True}


def _widget_html(b64: str, kind: str, uid: str, ttl: int) -> str:
    """把 base64 填进 assets/qr-widget.html，返回可直接喂给 show_widget 的 HTML。"""
    root = Path(__file__).resolve().parent.parent
    tpl = root / "templates" / "qr-widget.html"
    if not tpl.exists():
        tpl = root / "assets" / "qr-widget.html"   # 兼容旧版目录
    if tpl.exists():
        html = tpl.read_text(encoding="utf-8")
        html = re.sub(r"<!--.*?-->", "", html, flags=re.S)
    else:
        html = ('<div style="text-align:center"><img src="data:image/png;base64,{{B64}}" '
                'style="width:172px;height:172px"><p>{{TITLE}}</p><p>{{HINT}}</p>'
                '<p>剩余 {{TTL}} 秒</p><p>uuid {{UUID}}</p></div>')
    if kind == "wechat":
        title, hint = "微信扫一扫登录", "手机微信 → 右上角「+」→ 扫一扫"
    else:
        title, hint = "APP 扫一扫登录", "烟草网络学院 APP → 右上角扫一扫"
    filled = (html.replace("{{B64}}", b64).replace("{{TITLE}}", title)
                  .replace("{{HINT}}", hint).replace("{{TTL}}", str(ttl))
                  .replace("{{UUID}}", uid[:8]))
    return " ".join(line.strip() for line in filled.splitlines() if line.strip())


def run_watch(m: MoocAuth, kind: str, ttl: int, cycles: int, outdir: str,
              inline: bool = False, widget: bool = False) -> dict:
    """无人扫码场景：验证过期判定与自动重取二维码。

    inline=True 时每轮额外输出一行 `QR_B64#<cycle>|<uuid>|<ttl>|<base64>`；
    widget=True 时再输出一行 `WIDGET#<cycle>|<html>`，可直接作为 show_widget 的入参。
    """
    def on_qr(k, uid, png, cycle):
        log(f"QR_ISSUED#{cycle}", channel=k, uuid=uid, bytes=len(png),
            file=f"{outdir}/qr-{k}-{cycle}.png", ttl=f"~{ttl}s")
        if inline or widget:
            b64 = base64.b64encode(png).decode()
        if inline:
            print(f"QR_B64#{cycle}|{uid}|{ttl}|{b64}", flush=True)
        if widget:
            print(f"WIDGET#{cycle}|{_widget_html(b64, k, uid, ttl)}", flush=True)

    def on_poll(cycle, data):
        log(f"POLL#{cycle}", body=json.dumps(data, ensure_ascii=False)[:120] or "{}")

    res = m.wait_login(kind=kind, ttl=ttl, max_cycles=cycles,
                       on_qr=on_qr, on_poll=on_poll,
                       save_dir=outdir)
    for ev in res["events"]:
        log("CYCLE_END", **ev)
        # 给 Agent 一个明确的"该换码了"信号，避免它只看到 ttl 猜原因
        if ev.get("ended") and ev["ended"] != "scanned":
            print(f"QR_EXPIRED#{ev['cycle']}|reason={ev['ended']}|elapsed={ev['elapsed']}s",
                  flush=True)
    log("RESULT", ok=res.get("ok"), timeout=res.get("timeout", False),
        cycles=len(res["events"]))
    if res.get("ok"):
        _auto_save(res.get("token"), channel)
        print("LOGIN_OK|" + json.dumps(res.get("token"), ensure_ascii=False)[:600], flush=True)
    return res


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("kind", choices=["wechat", "app", "watch"])
    p.add_argument("--key", required=True, help="hashKey（会话 key）")
    p.add_argument("--seconds", type=int, default=90)
    p.add_argument("--out", default=".")
    p.add_argument("--channel", choices=["wechat", "app"], default="wechat",
                   help="watch 模式测哪条通道")
    p.add_argument("--ttl", type=int, default=60, help="单张二维码的等待上限")
    p.add_argument("--cycles", type=int, default=2, help="自动重取的最大轮数")
    p.add_argument("--inline", action="store_true",
                   help="每轮额外输出 QR_B64#n|<uuid>|<ttl>|<base64>，供对话内联渲染")
    p.add_argument("--widget", action="store_true",
                   help="每轮输出 WIDGET#n|<html>，可直接作为 show_widget 入参")
    a = p.parse_args()

    m = MoocAuth(session_key=a.key)
    if a.kind == "watch":
        res = run_watch(m, a.channel, a.ttl, a.cycles, a.out,
                        inline=a.inline, widget=a.widget)
        return 0 if res.get("ok") or res.get("timeout") else 1

    res = run_wechat(m, a.seconds, a.out) if a.kind == "wechat" else run_app(m, a.seconds, a.out)
    if res.get("ok"):
        _auto_save(res.get("token"), a.channel)
    log("RESULT", **res)
    return 0


if __name__ == "__main__":
    sys.exit(main())
