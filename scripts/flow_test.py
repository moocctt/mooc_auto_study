#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""两条扫码链路的端到端实测：取码 -> 轮询 -> 换凭证。

用法：
    python flow_test.py wechat --key <hashKey> --seconds 90 --out wx.png
    python flow_test.py app    --key <hashKey> --seconds 90 --out app.png
    python flow_test.py watch  --channel app --ttl 55 --cycles 2

输出为逐行 STEP 日志（带时间戳），便于后台运行后回读。
默认只打印 token 前 10 位（与 mooc_api.py 的默认展示一致），
需要完整值请显式加 --full。
退出码：0 登录成功；1 失败（含换票被拒）；3 等码超时。
"""
from __future__ import annotations

import argparse
import base64
import json
import re
import sys
import time
from pathlib import Path

import requests

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
        data = json.loads(text)
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}      # list/标量：下游都按 dict 取字段


def _mask(token) -> str:
    """token 只露前 10 位：会话凭证不进日志，要完整值必须显式 --full。"""
    if not token:
        return ""
    s = str(token)
    return s[:10] + "…" if len(s) > 10 else "…"      # 短 token 也不能整颗露出


_ACCESS_FIELD_RE = re.compile(
    r'("(?:access_token|loginToken|refresh_token)"\s*:\s*")([^"]{0,10})[^"]*(")')


def _redact(text: str, full: bool = False) -> str:
    """原始响应文本里的凭证字段同样要脱敏：轮询日志会把 body 整段打出来。"""
    if full or not text:
        return text
    return _ACCESS_FIELD_RE.sub(r"\1\2…\3", text)


def _token_view(token_obj, full: bool):
    """打印前的 token 形状：默认脱敏换票字段，--full 才原样输出。"""
    if full:
        return token_obj
    if isinstance(token_obj, dict):
        return {k: (_mask(v) if k in ("access_token", "loginToken", "refresh_token") else v)
                for k, v in token_obj.items()}
    return _mask(token_obj)


def run_wechat(m: MoocAuth, seconds: int, out: str, full: bool = False) -> dict:
    try:
        url, png = m.create_wechat_qr(out)
    except Exception as exc:                    # 网络抖动/HTML 错误页不该抛栈
        log("STEP1_ERR", channel="wechat", err=f"{type(exc).__name__}: {exc}"[:160])
        return {"ok": False, "kind": "wechat", "error": "create_qr_failed"}
    log("STEP1_QR", channel="wechat", uuid=m.wechat_uuid, url=url,
        file=out, bytes=len(png), ttl=f"~{seconds}s")

    t0 = time.time()
    n = 0
    while time.time() - t0 < seconds:
        n += 1
        try:
            r = m.s.post(API + "/checkUUIDStatus",
                         params={"uuid": m.wechat_uuid}, timeout=m.timeout)
        except requests.RequestException as exc:
            log(f"POLL{n}", err=f"{type(exc).__name__}: {exc}"[:120])
            time.sleep(2)
            continue
        body = r.text.strip()
        log(f"POLL{n}", http=r.status_code, body=_redact(body, full)[:160])

        data = _json_or_empty(body)
        if data.get("status") and data.get("openId"):
            oid = data["openId"]
            log("SCANNED", openId=oid)
            # 判据与 mooc_api.wait_any 一致：换票真的拿到 access_token 才算成功
            try:
                ex = m.exchange_wechat(oid)
            except Exception as exc:
                ex = {"ok": False, "reason": "exception",
                      "error": f"{type(exc).__name__}: {exc}"[:160]}
            if ex.get("ok"):
                tok = ex.get("token") or {}
                log("STEP3_TOKEN", tries=ex.get("tries"),
                    token=_token_view(tok, full))
                return {"ok": True, "kind": "wechat", "token": tok}
            log("EXCHANGE_FAIL", reason=ex.get("reason"),
                http=ex.get("http_status"), detail=ex.get("body") or ex.get("error"))
            return {"ok": False, "kind": "wechat", "reason": "exchange_failed",
                    "detail": ex}
        if data.get("code") == "0002":
            log("EXPIRED", code="0002")
            return {"ok": False, "kind": "wechat", "expired": True}
        time.sleep(2)

    log("TIMEOUT", polls=n)
    return {"ok": False, "kind": "wechat", "timeout": True}


def run_app(m: MoocAuth, seconds: int, out: str, full: bool = False) -> dict:
    try:
        png = m.fetch_app_qr(out)
    except Exception as exc:
        log("STEP1_ERR", channel="app", err=f"{type(exc).__name__}: {exc}"[:160])
        return {"ok": False, "kind": "app", "error": "create_qr_failed"}
    log("STEP1_QR", channel="app", uuid=m.uuid, file=out, bytes=len(png),
        ttl=f"~{seconds}s")

    t0 = time.time()
    n = 0
    last_bad = None
    while time.time() - t0 < seconds:
        n += 1
        try:
            r = m.s.get(API + "/loginCheck",
                        params={"uuid": aes_encrypt(m.uuid),
                                "organizationId": aes_encrypt(ORG_ID),
                                "key": m.session_key},
                        timeout=m.timeout)
        except requests.RequestException as exc:
            log(f"POLL{n}", err=f"{type(exc).__name__}: {exc}"[:120])
            time.sleep(2)
            continue
        body = r.text.strip()
        log(f"POLL{n}", http=r.status_code, body=_redact(body, full)[:200])
        if r.status_code != 200:
            last_bad = {"http": r.status_code, "body": _redact(body, full)[:160]}
            time.sleep(2)
            continue
        data = _json_or_empty(body)
        # APP 通道判据同 wait_any：只有响应里真有 access_token 才算扫码成功
        if isinstance(data, dict) and data.get("access_token"):
            log("STEP3_TOKEN", http=r.status_code, token=_token_view(data, full))
            return {"ok": True, "kind": "app", "token": data}
        if body and body not in ("{}", "null"):
            # 服务端会把错误文本以 200 返回；没有 access_token 一律不算成功，继续等
            last_bad = {"http": r.status_code, "body": _redact(body, full)[:160]}
            log("STEP3_NO_TOKEN", http=r.status_code, body=_redact(body, full)[:160])
        time.sleep(2)

    log("TIMEOUT", polls=n, last_bad=last_bad)
    res = {"ok": False, "kind": "app", "timeout": True}
    if last_bad:
        res["reason"] = "no_access_token"
        res["detail"] = last_bad
    return res


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
              inline: bool = False, widget: bool = False, full: bool = False) -> dict:
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
        # 轮询回包里可能已经带 access_token，默认同样脱敏
        log(f"POLL#{cycle}",
            body=json.dumps(_token_view(data, full), ensure_ascii=False)[:120])

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
        # 会话端归属用实际通道（qr-app / qr-wechat），不是 --channel 之外的猜测
        _auto_save(res.get("token"), res.get("kind") or kind)
        print("LOGIN_OK|" + json.dumps({"kind": res.get("kind"),
                                        "token": _token_view(res.get("token"), full)},
                                       ensure_ascii=False)[:600], flush=True)
    return res


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("kind", choices=["wechat", "app", "watch"])
    p.add_argument("--key", help="hashKey（会话 key）；不传则用登录页默认 key（服务端会校验一致性）")
    p.add_argument("--seconds", type=int, default=90, help="单次等扫码的秒数（wechat/app 模式）")
    p.add_argument("--out", default=".", help="二维码落盘路径（PNG 文件名）；watch 模式下当目录用")
    p.add_argument("--channel", choices=["wechat", "app"], default="wechat",
                   help="watch 模式测哪条通道")
    p.add_argument("--ttl", type=int, default=60, help="单张二维码的等待上限")
    p.add_argument("--cycles", type=int, default=2, help="自动重取的最大轮数")
    p.add_argument("--inline", action="store_true",
                   help="每轮额外输出 QR_B64#n|<uuid>|<ttl>|<base64>，供对话内联渲染")
    p.add_argument("--widget", action="store_true",
                   help="每轮输出 WIDGET#n|<html>，可直接作为 show_widget 入参")
    p.add_argument("--full", action="store_true",
                   help="输出完整 token；默认只显示前 10 位，避免会话凭证明文进日志")
    a = p.parse_args()

    try:
        m = MoocAuth(session_key=a.key)
        if a.kind == "watch":
            res = run_watch(m, a.channel, a.ttl, a.cycles, a.out,
                            inline=a.inline, widget=a.widget, full=a.full)
            return 0 if res.get("ok") else (3 if res.get("timeout") else 1)

        res = (run_wechat(m, a.seconds, a.out, full=a.full) if a.kind == "wechat"
               else run_app(m, a.seconds, a.out, full=a.full))
        if res.get("ok"):
            # 会话端归属按实际通道（qr-app / qr-wechat），与 mooc_api 的 source 命名一致
            _auto_save(res.get("token"), res.get("kind") or a.kind)
        shown = dict(res)
        if "token" in shown:
            shown["token"] = _token_view(shown["token"], a.full)
        log("RESULT", **shown)
        if res.get("ok"):
            return 0
        return 3 if res.get("timeout") else 1
    except Exception as exc:                   # 兜底：任何异常都给可读原因，不甩栈
        log("FATAL", err=f"{type(exc).__name__}: {exc}"[:200])
        return 1


if __name__ == "__main__":
    sys.exit(main())
