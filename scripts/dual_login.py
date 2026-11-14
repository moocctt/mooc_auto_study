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
  EXCHANGE_SKIP#n|ch=...|reason=...|hint=...   扫码了但换票没过（可再试）
  LOGIN_OK|{"channel":...,"token":{...}}       token 默认只显示前 10 位，--full 才是完整值
  RESULT|ok=...|...

退出码：0 登录成功或等码超时（无人扫码属于预期结果）；1 取码/轮询异常。
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


def _mask(token) -> str:
    """token 只露前 10 位：会话凭证不进日志，要完整值必须显式 --full。"""
    if not token:
        return ""
    s = str(token)
    return s[:10] + "…" if len(s) > 10 else "…"      # 短 token 也不能整颗露出


def _token_view(token_obj, full: bool):
    """LOGIN_OK 行的 token 形状：默认脱敏换票字段，--full 才原样输出。"""
    if full:
        return token_obj
    if isinstance(token_obj, dict):
        return {k: (_mask(v) if k in ("access_token", "loginToken", "refresh_token") else v)
                for k, v in token_obj.items()}
    return _mask(token_obj)


TRANSIENT_ERRORS = ("90101", "900001")


def _is_transient(detail) -> bool:
    """换票失败只是瞬时故障吗？

    90101（会话/key 未登记好）、900001（服务端 5xx 类）以及网络异常都不该把
    该 openId 永久拉黑 —— 它们跟「微信未绑定平台账号」不同，重扫一次常常就过了。
    """
    if not isinstance(detail, dict):
        return False
    if detail.get("reason") in ("network", "exception"):
        return True
    status = detail.get("http_status")
    if isinstance(status, int) and status >= 500:
        return True
    body = detail.get("body") if isinstance(detail.get("body"), dict) else {}
    code = str(body.get("errorCode") or body.get("code") or "")
    return code in TRANSIENT_ERRORS


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


def run(key: str | None, ttl: int, cycles: int, outdir: str,
        interval: float = 1.0, full: bool = False) -> dict:
    """返回 {"ok":bool} 或 {"ok":False,"error":True}（取码/轮询异常）。"""
    mw = MoocAuth(session_key=key)   # 微信通道（独立 session，避免串扰）
    ma = MoocAuth(session_key=key)   # APP 通道
    issue_err = None

    for cycle in range(1, cycles + 1):
        wx_path = f"{outdir}/qr-dual-wechat-{cycle}.png"
        ap_path = f"{outdir}/qr-dual-app-{cycle}.png"
        # 新码新机会：上一轮换票被拒的 openId 不该连带影响这一轮
        dead = getattr(mw, "_dead_openids", None)
        if dead:
            dead.clear()
        # 两张码并发取：两个实例各自持有独立 Session，互不影响
        t_issue = time.time()
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=2) as pool:
            f_wx = pool.submit(mw.create_wechat_qr, wx_path)
            f_ap = pool.submit(ma.fetch_app_qr, ap_path)
            errs: dict[str, str] = {}
            try:
                _url, png_wx = f_wx.result()
            except Exception as exc:            # 网络抖动/错误页不能抛栈
                errs["wechat"] = f"{type(exc).__name__}: {exc}"[:160]
            try:
                png_app = f_ap.result()
            except Exception as exc:
                errs["app"] = f"{type(exc).__name__}: {exc}"[:160]
        if errs:
            issue_err = errs
            log("QR_ISSUE_FAIL", cycle=cycle, **errs)
            print(f"QR_ISSUE_FAIL#{cycle}|" + json.dumps(errs, ensure_ascii=False),
                  flush=True)
            if len(errs) == 2:                  # 两张都没取到，这轮无码可展示
                print(f"RESULT|ok=False|error=True|cycles={cycle}", flush=True)
                return {"ok": False, "error": True}
            time.sleep(1.0)
            continue
        issue_err = None
        issued_ms = round((time.time() - t_issue) * 1000)
        b64w = base64.b64encode(png_wx).decode()
        b64a = base64.b64encode(png_app).decode()
        uid_w, uid_a = mw.wechat_uuid or "", ma.uuid or ""

        log("DUAL_ISSUED", cycle=cycle, wechat_uuid=uid_w, app_uuid=uid_a,
            wechat_bytes=len(png_wx), app_bytes=len(png_app), issued_ms=issued_ms,
            ttl=f"~{ttl}s")
        print(f"DUAL_QR#{cycle}|{ttl}|{uid_w}|{uid_a}|{b64w}|{b64a}", flush=True)
        print(f"WIDGET#{cycle}|{dual_widget(b64w, b64a, uid_w, uid_a, ttl, cycle)}",
              flush=True)

        # 单实例轮询两条通道：扫到即换票、换票结果校验、失败自动重试 3 次。
        # 旧实现在 status_code==200 就当成功，换票被拒（平台回 422/errorCode）
        # 会打印 LOGIN_OK 但其实没有凭证 —— 这是「扫了没反应」的主要来源。
        mw.uuid = ma.uuid
        try:
            res = mw.wait_any(seconds=ttl, interval=interval)
        except Exception as exc:                # 轮询层异常也不该甩栈
            err = f"{type(exc).__name__}: {exc}"[:160]
            log("POLL_FAIL", cycle=cycle, err=err)
            print(f"RESULT|ok=False|error=True|cycles={cycle}|err={err}", flush=True)
            return {"ok": False, "error": True}

        if res.get("ok"):
            token, channel = res["token"], res["channel"]
            try:
                from mooc_tasks import save_token_from_login
                saved = save_token_from_login(token, f"qr-{channel}")
                if saved:
                    log("SESSION_SAVED", enc=saved["enc"], expires_at=saved["expires_at"])
            except Exception as exc:
                log("SESSION_SAVE_ERR", err=str(exc)[:120])
            log("LOGIN_FAST", channel=channel, scanned_after=res.get("scanned_after"),
                exchange_ms=res.get("exchange_ms"), tries=res.get("tries"))
            print("LOGIN_OK|" + json.dumps({"channel": channel,
                                            "scanned_after": res.get("scanned_after"),
                                            "exchange_ms": res.get("exchange_ms"),
                                            "token": _token_view(token, full)},
                                           ensure_ascii=False)[:700], flush=True)
            print(f"RESULT|ok=True|channel={channel}|cycles={cycle}", flush=True)
            return {"ok": True}

        for ev in res.get("events", []):
            if ev.get("event") == "scanned" and not ev.get("ok"):
                detail = ev.get("detail")
                transient = _is_transient(detail)
                log("EXCHANGE_FAIL", ch=ev.get("ch"), transient=transient, detail=detail)
                if transient:
                    # 瞬时失败不永久拉黑：清掉本轮黑名单，重跑/换码立刻可再试
                    dead = getattr(mw, "_dead_openids", None)
                    if dead:
                        dead.clear()
                    hint = "瞬时失败，本次已跳过，重跑或换码可再试"
                else:
                    hint = "换票被拒（如微信未绑定平台账号），本次已跳过，处理后重跑可再试"
                log("EXCHANGE_SKIP", ch=ev.get("ch"), hint=hint)
                print(f"EXCHANGE_SKIP#{cycle}|ch={ev.get('ch')}|"
                      f"reason={'transient' if transient else 'rejected'}|hint={hint}",
                      flush=True)
        print(f"DUAL_EXPIRED#{cycle}|reason=ttl|elapsed={res.get('elapsed')}s", flush=True)

    print(f"RESULT|ok=False|timeout=True|cycles={cycles}", flush=True)
    return {"ok": False, "error": bool(issue_err)}


def main() -> int:
    p = argparse.ArgumentParser(description="同时展示微信码与 APP 码，任一扫到即登录")
    p.add_argument("--key", help="hashKey（会话 key）；不传则用登录页默认 key")
    p.add_argument("--ttl", type=int, default=55, help="单轮两张码的有效等待秒数")
    p.add_argument("--cycles", type=int, default=3, help="过期自动重取的最大轮数")
    p.add_argument("--interval", type=float, default=1.0, help="轮询间隔秒（越小换票越快）")
    p.add_argument("--out", default=".", help="二维码落盘目录（须在会话工作区内）")
    p.add_argument("--full", action="store_true",
                   help="LOGIN_OK 里输出完整 token；默认只显示前 10 位")
    a = p.parse_args()
    try:
        Path(a.out).mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        print(f"RESULT|ok=False|error=True|err=落盘目录不可用: {exc}", flush=True)
        return 1
    # 无人扫码属于预期结果，不算脚本失败；只有取码/轮询异常才返回非 0
    res = run(a.key, a.ttl, a.cycles, a.out, a.interval, full=a.full)
    return 1 if res.get("error") else 0


if __name__ == "__main__":
    sys.exit(main())
