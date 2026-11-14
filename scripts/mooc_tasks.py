#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""学习任务采集 / 学时总览 / 同步到本地任务库（纯 HTTP，不依赖浏览器）。

2026-11-04 真实抓包验证（账号登录后学习中心）：

  GET /api/v1/human/task?page=1&pageSize=100   -> {"items":[...],"recordCount":69}
  GET /api/v1/system/credit/detail-hour-member -> 学时总览
  GET /api/v1/human/member/center              -> 当前用户信息

认证头必须是 **Bearer__<access_token>**（双下划线），不是 "Bearer "：
    Authorization: Bearer__<access_token>
  写成空格或省略会返回 401 Access is Denied。

学时总览的两组字段（按用户确认的中文命名，勿混用）：
    网络自学 = courseHourResult.totalHour(已完成) / requireCourseHour(要求)
    集中培训 = totalClassHour(已完成)           / requireClassHour(要求)
  注意 courseHourResult 是嵌套对象，不存在顶层 totalHour。

任务字段映射见 references/task-api.md。仅读取与排期，不自动播放课程、不代考。
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import subprocess
import sys
import time
from datetime import date, datetime, timedelta
from pathlib import Path

import requests

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from tobacco import (CN_TZ, CRED_FILE, DATA_DIR, PROFILE_FILE, TASKS_FILE,  # noqa: E402
                     _protect, _restrict_permissions, _unprotect, cn_today,
                     load_json, now_iso, save_json)


class AuthExpired(Exception):
    """token 失效（HTTP 401）。

    不继承 RuntimeError：上层有 `except RuntimeError` 包着单课/单目标的容错，
    401 必须穿过去让进程以退出码 2 结束，而不是被当成"这个小节失败"继续跑。
    """

BASE = "https://mooc.ctt.cn"
API = BASE + "/api/v1"
SESSION_FILE = DATA_DIR / "session.dat"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/156.0 Safari/537.36")

# businessType -> 本地任务类型（对照真实任务名核实过）
BUSINESS_KIND = {1: "course", 2: "course", 3: "exam", 4: "survey",
                 5: "class_task", 6: "live"}
BUSINESS_LABEL = {1: "课程", 2: "专题", 3: "考试", 4: "问卷",
                  5: "班级", 6: "直播"}
# 平台未返回 duration 时的保守估值（单位：学时），仅供排期用，会在 notes 标注
DEFAULT_HOURS = {"course": 2.0, "exam": 1.0, "survey": 0.2,
                 "class_task": 4.0, "live": 1.5, "other": 1.0}
# 已在页面上验证过的详情路由；未验证的类型不拼 URL，只在 notes 里留 businessId
URL_TEMPLATES = {
    2: BASE + "/#/study/subject/detail/{bid}",
    5: BASE + "/#/train-new/class-detail/{bid}",
    1: BASE + "/#/study/course/detail/4&{bid}",   # 由首页课程链接推断
}


# --------------------------------------------------------------------------- #
# 会话管理：token 用与密码相同的 DPAPI 机制加密落在本地
# --------------------------------------------------------------------------- #
def save_session(token: str, expires_in: int = 14400, source: str = "unknown") -> dict:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    enc, blob = _protect(token)
    if enc == "plain":                    # 无 DPAPI/keyring：违背「加密会话」承诺，必须让用户看见
        print(f"[会话] ⚠️ 本机没有可用的加密后端（DPAPI/keyring），"
              f"会话将以明文 base64 保存到 {SESSION_FILE}", file=sys.stderr)
    obj = {"enc": enc,
           "token_source": source,    # app-login=APP 端 / qr-wechat,qr-app=网页端（按端单会话）
           "token_b64": base64.b64encode(blob).decode("ascii"),
           "saved_at": datetime.now().isoformat(timespec="seconds"),
           "expires_at": (datetime.now() + timedelta(seconds=expires_in))
           .isoformat(timespec="seconds")}
    try:                                  # 原子写：tmp + replace，避免中断留下半个文件
        save_json(SESSION_FILE, obj)
    except (SystemExit, RuntimeError):
        SESSION_FILE.write_text(json.dumps(obj, ensure_ascii=False, indent=2),
                                encoding="utf-8")
    _restrict_permissions(SESSION_FILE)
    return {"saved": True, "enc": enc, "expires_at": obj["expires_at"],
            "source": source, "file": str(SESSION_FILE)}


def save_token_from_login(token_obj, source: str = "qr-wechat") -> dict | None:
    """登录成功后由 dual_login / flow_test 调用，把 token 落成本地会话。

    返回 None 表示响应里没有 access_token（例如登录失败），调用方应忽略。
    """
    if not isinstance(token_obj, dict):
        return None
    tok = token_obj.get("access_token")
    if not tok:
        return None
    return save_session(str(tok), int(token_obj.get("expires_in") or 14400), source)


def load_session() -> tuple[str, dict]:
    """返回 (token, session_meta)。优先命令行/环境变量，其次本地会话文件。"""
    env = os.environ.get("MOOC_TOKEN", "").strip()
    if env:
        return env, {"source": "env", "expires_at": None}
    if not SESSION_FILE.exists():
        raise SystemExit("缺少 access_token：先运行 `mooc_tasks.py session --token <token>`，"
                         "或设置环境变量 MOOC_TOKEN。")
    try:
        obj = json.loads(SESSION_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise SystemExit(f"本地会话文件无法解析（{e}）：{SESSION_FILE}\n"
                         "请重新扫码登录，或用 `mooc_tasks.py session --token <token>` 覆盖它。")
    if not isinstance(obj, dict):
        raise SystemExit(f"本地会话文件结构异常：{SESSION_FILE}，请重新登录后覆盖。")
    exp = obj.get("expires_at")
    if exp and datetime.fromisoformat(exp) <= datetime.now():
        raise SystemExit(f"本地会话已于 {exp} 过期，请重新扫码登录并再存一次 token。")
    token = _unprotect(obj.get("enc", "plain"), obj.get("token_b64", ""))
    if not token:
        raise SystemExit("会话解密失败，请重新保存 token。")
    return token, {"source": "session", **{k: v for k, v in obj.items() if k != "token_b64"}}


def _safe_out(raw: str) -> Path:
    """把 --out / --keep-file 路径变成绝对路径，并拦下会覆盖凭据/会话/任务库的写法。"""
    p = Path(raw).expanduser()
    try:
        p = p.resolve()
    except OSError:
        p = p.absolute()
    if p.is_dir():
        raise SystemExit(f"{p} 是目录，--out/--keep-file 需要文件路径。")
    # 凭据真名是 credentials.dat（tobacco.CRED_FILE）；数据目录整体不外借，
    # 任何文件写进去都可能撞上会话/凭据/任务库/账本
    try:
        data_dir = DATA_DIR.resolve()
    except OSError:
        data_dir = DATA_DIR.absolute()
    if p == data_dir or p.is_relative_to(data_dir):
        raise SystemExit(f"拒绝写入 {p}：{DATA_DIR} 是 skill 自己的数据目录，"
                         "换个位置（比如 %TEMP%\\import.json）。")
    for real in (SESSION_FILE, CRED_FILE, TASKS_FILE, PROFILE_FILE):
        try:
            target = Path(real).resolve()
        except OSError:
            target = Path(real).absolute()
        if p == target:
            raise SystemExit(f"拒绝写入 {p}：这是 skill 自己的数据文件，"
                             "换个文件名（比如 %TEMP%\\import.json）。")
    if p.name in {"session.dat", "credentials.dat", "credentials.json",
                  "tasks.json", "profile.json", "today_used.json"}:
        raise SystemExit(f"拒绝写入 {p}：这是 skill 自己的数据文件名，"
                         "换个文件名（比如 %TEMP%\\import.json）。")
    return p


def api_session(token: str) -> requests.Session:
    s = requests.Session()
    s.headers.update({
        "Authorization": f"Bearer__{token}",   # 双下划线，平台自定义格式
        "X-Requested-With": "XMLHttpRequest",
        "User-Agent": UA,
        "Accept": "*/*",
        "Referer": BASE + "/",
    })
    return s


def _get(s: requests.Session, path: str, params: dict | None = None) -> dict:
    r = s.get(API + path, params={**(params or {}), "_": int(time.time() * 1000)},
              timeout=20)
    if r.status_code == 401:
        raise AuthExpired("401 Access is Denied：token 无效或已过期，请重新扫码登录。")
    r.raise_for_status()
    return r.json()


# --------------------------------------------------------------------------- #
# 方式三：账密登录（APP 通道）
# --------------------------------------------------------------------------- #
def read_saved_credentials() -> tuple[str, str]:
    """返回本地保存的 (账号, 密码)；未保存或解密失败则为空串。"""
    if not CRED_FILE.exists():
        return "", ""
    obj = load_json(CRED_FILE, {})
    user = str(obj.get("username") or "")
    try:
        pwd = _unprotect(obj.get("enc", "plain"), obj.get("secret", ""))
    except Exception:
        pwd = ""
    return user, pwd


def save_credentials(username: str, password: str) -> str:
    """保存账号密码（DPAPI 加密，仅当前用户可解）。返回实际使用的加密方式。"""
    enc, blob = _protect(password)
    save_json(CRED_FILE, {"version": 1, "username": username, "enc": enc,
                          "secret": base64.b64encode(blob).decode("ascii"),
                          "saved_at": now_iso()})
    _restrict_permissions(CRED_FILE)
    return enc


def login_password(username: str | None = None, password: str | None = None,
                   company: str | None = None) -> dict:
    """账密登录 → 存会话 → 探活。返回结构化结果，失败抛 mooc_api.LoginError。

    账密来源优先级：显式入参 > 命令行密码 > 本地 credentials.dat。
    """
    from mooc_api import APP_LOGIN_COMPANY, LoginError, MoocAuth

    saved_user, saved_pwd = read_saved_credentials()
    username = (username or saved_user or "").strip()
    # 只在"当前账号就是已保存的那个"时才复用已存密码，避免 A 的密码配 B 的账号
    if password is None and saved_user and username == saved_user:
        password = saved_pwd
    if not username:
        raise SystemExit("缺少账号：用 --username 提供，或先运行 "
                         "`tobacco.py cred set --username <账号>` 保存。")
    if not password:
        raise SystemExit("缺少密码：用 --password-stdin 从标准输入提供，"
                         "或先运行 `tobacco.py cred set` 保存。")

    resp = MoocAuth().app_login(username, password,
                                company_name=company or APP_LOGIN_COMPANY)
    token = str(resp["access_token"])
    ttl = int(resp.get("expires_in") or 30 * 24 * 3600)
    sess = save_session(token, ttl, "app-login")

    # 立刻探活：确认 token 真能过业务接口，避免"登录成功但进不去"
    member, probe_error = None, None
    try:
        j = _get(api_session(token), "/human/member/center")
        member = {"name": j.get("fullName"),
                  "org": (j.get("organization") or {}).get("fullName"),
                  "member_id": j.get("id")}
    except SystemExit as exc:      # _get 用 SystemExit 报 401，必须单独接住
        probe_error = str(exc)
    except Exception as exc:
        probe_error = str(exc)[:200]

    return {
        "ok": probe_error is None,
        "login_method": "app-login",
        "username": username,
        "userid": resp.get("userid"),
        "member": member,
        "probe_error": probe_error,
        "token_type": resp.get("token_type", "Bearer"),
        "expires_in": ttl,
        "expires_at": sess["expires_at"],
        "session_file": sess["file"],
    }


# --------------------------------------------------------------------------- #
# 密码兜底：本地一次性表单页（密码不进对话、不进命令历史）
# --------------------------------------------------------------------------- #
_FORM_CSS = """
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
  background:#f1f6f3;color:#16241c;
  font:15px/1.6 "PingFang SC","Microsoft YaHei",system-ui,-apple-system,sans-serif}
.card{width:min(430px,92vw);background:#fff;border:1px solid #e3ebe6;border-radius:14px;
  padding:26px 26px 20px;box-shadow:0 14px 44px rgba(18,74,49,.13)}
h1{margin:0 0 4px;font-size:19px;letter-spacing:.4px}
.sub{margin:0 0 18px;font-size:13px;color:#6b7a73}
label{display:block;margin:13px 0 6px;font-size:13px;font-weight:500}
input[type=text],input[type=password]{width:100%;padding:10px 12px;font-size:15px;
  border:1px solid #cfdad4;border-radius:8px;background:#fbfdfc;outline:none}
input[type=text]:focus,input[type=password]:focus{border-color:#2e8b5f;
  box-shadow:0 0 0 3px rgba(46,139,95,.14)}
.row{display:flex;align-items:center;gap:7px;margin-top:15px}
.cb{margin:0;font-size:13px;font-weight:400;color:#4a5a52}
button{margin-top:20px;width:100%;padding:11px;border:0;border-radius:8px;
  background:#1f6f4a;color:#fff;font-size:15px;font-weight:500;cursor:pointer}
button:hover{background:#195c3d}
.note{margin:16px 0 0;padding-top:12px;border-top:1px solid #eef2f0;
  font-size:12px;line-height:1.7;color:#88968f}
.err{margin:0 0 4px;padding:9px 12px;border:1px solid #f2d3d3;border-radius:8px;
  background:#fdf3f3;color:#b3261e;font-size:13px}
.badge{width:44px;height:44px;border-radius:50%;display:flex;align-items:center;
  justify-content:center;font-size:22px;margin-bottom:12px}
.badge.ok{background:#e7f4ec;color:#1f6f4a}
.badge.no{background:#fdeced;color:#b3261e}
.detail{margin:8px 0 0;font-size:14px;color:#3d4c45;white-space:pre-line}
"""

_FORM_HTML = """<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>烟草网络学院 · 账号登录</title>
<style>__CSS__</style></head>
<body><main class="card">
<h1>烟草网络学院</h1>
<p class="sub">账号登录 · 本机一次性表单</p>
__ERROR__
<form method="post" action="__ACTION__">
  <label for="u">账号（手机号 / 工号）</label>
  <input id="u" name="username" type="text" value="__USER__" required autofocus autocomplete="username">
  <label for="p">密码</label>
  <input id="p" name="password" type="password" required autocomplete="current-password">
  <label for="c">单位（可选，留空即「全行业」）</label>
  <input id="c" name="company" type="text" value="__COMPANY__" autocomplete="off">
  <div class="row"><input id="s" name="save" type="checkbox" value="1"__SAVE__>
    <label class="cb" for="s">在本机加密保存账号密码，下次免输</label></div>
  <button type="submit">登录</button>
</form>
<p class="note">密码只提交到本机 127.0.0.1 的临时端口，登录完成即关闭；不写入对话记录，也不进命令历史。地址带一次性随机码，过期失效。</p>
</main></body></html>"""

_DONE_HTML = """<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>__TITLE__</title>
<style>__CSS__</style></head>
<body><main class="card">
<div class="badge __CLS__">__ICON__</div>
<h1>__TITLE__</h1>
<p class="detail">__DETAIL__</p>
<p class="note">可以关闭此页面，回到对话继续。</p>
</main></body></html>"""


def _fill(tpl: str, **kw: str) -> str:
    out = tpl.replace("__CSS__", _FORM_CSS)
    for key, value in kw.items():
        out = out.replace("__" + key.upper() + "__", value)
    return out


def login_form(timeout: int = 300, open_browser: bool = True,
               save_creds: bool = False, company: str | None = None,
               max_tries: int = 5) -> dict:
    """在 127.0.0.1 起一次性表单页收账号密码，提交后直接登录并立刻关端口。

    密码从浏览器直达本进程内存：不经过对话记录、不经过 shell 历史、不出现在
    命令行参数与进程列表里。只监听回环地址，表单路径带一次性随机 token。
    """
    import secrets
    import webbrowser
    from html import escape
    from http.server import BaseHTTPRequestHandler, HTTPServer
    from urllib.parse import parse_qs

    token = secrets.token_urlsafe(18)
    path = "/" + token
    state: dict = {"done": False, "result": None, "tries": 0}

    try:
        saved_user, _ = read_saved_credentials()
    except Exception:
        saved_user = ""

    def page_form(user: str, comp: str, error: str, keep: bool) -> str:
        err_html = f'<p class="err">{escape(error)}</p>' if error else ""
        return _fill(_FORM_HTML, action=path, user=escape(user),
                     company=escape(comp), error=err_html,
                     save=" checked" if keep else "")

    def page_done(ok: bool, title: str, detail: str) -> str:
        return _fill(_DONE_HTML, title=escape(title), detail=escape(detail),
                     cls="ok" if ok else "no", icon="✓" if ok else "!")

    class Handler(BaseHTTPRequestHandler):
        server_version = "mooc-login-form"
        sys_version = ""

        def log_message(self, *args):  # 默认日志含 token，必须静音
            return

        def _send(self, code: int, text: str) -> None:
            body = text.encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("X-Frame-Options", "DENY")
            self.send_header("Content-Security-Policy",
                             "default-src 'none'; style-src 'unsafe-inline'; "
                             "form-action 'self'; base-uri 'none'; frame-ancestors 'none'")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):  # noqa: N802
            if self.path.split("?")[0] != path:
                self._send(404, "<!doctype html><meta charset='utf-8'><h1>404</h1>")
                return
            self._send(200, page_form(saved_user, company or "", "", save_creds))

        def do_POST(self):  # noqa: N802
            if self.path.split("?")[0] != path:
                self._send(404, "<!doctype html><meta charset='utf-8'><h1>404</h1>")
                return
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                length = 0
            if length <= 0 or length > 8192:
                self._send(400, "<!doctype html><meta charset='utf-8'><h1>400</h1>")
                return
            form = parse_qs(self.rfile.read(length).decode("utf-8", "replace"))
            user = (form.get("username") or [""])[0].strip()
            pwd = (form.get("password") or [""])[0]
            comp = (form.get("company") or [""])[0].strip() or company
            keep = bool(form.get("save")) or save_creds

            if not user or not pwd:
                self._send(200, page_form(user, comp or "", "账号和密码都要填。", keep))
                return

            from mooc_api import LoginError

            state["tries"] += 1
            try:
                res = login_password(user, pwd, comp)
            except LoginError as exc:
                msg = f"[{exc.code or exc.http_status}] {exc.hint}"
                if state["tries"] >= max_tries:
                    self._send(200, page_done(
                        False, "密码错误次数过多", "表单已关闭，请重新运行 login-form。"))
                    state["result"] = {"ok": False, "reason": "too_many_tries", "error": msg}
                    state["done"] = True
                else:
                    self._send(200, page_form(user, comp or "", msg, keep))
                return
            except SystemExit as exc:
                msg = str(exc)
                self._send(200, page_done(False, "登录信息不完整", msg))
                state["result"] = {"ok": False, "reason": "missing_input", "error": msg}
                state["done"] = True
                return
            except Exception as exc:                       # 网络异常等可重试
                msg = f"{type(exc).__name__}: {exc}"[:200]
                self._send(200, page_form(user, comp or "", "登录请求失败：" + msg, keep))
                return

            if keep:
                try:
                    res["creds_saved"] = save_credentials(res["username"], pwd)
                except Exception as exc:
                    res["creds_saved"] = f"保存失败：{exc}"
            state["result"] = res
            member = res.get("member") or {}
            who = member.get("name") or "（探活未通过）"
            detail = (member.get("org") or "") + (
                f"\n有效期至 {res['expires_at']}" if res.get("expires_at") else "")
            self._send(200, page_done(True, f"登录成功：{who}", detail.strip()))
            state["done"] = True

    srv = HTTPServer(("127.0.0.1", 0), Handler)
    srv.timeout = 1
    url = f"http://127.0.0.1:{srv.server_address[1]}{path}"
    print(f"[表单] {url}", flush=True)
    print(f"[提示] {timeout} 秒内提交；登录完成后端口立即关闭，密码不进对话与命令历史。",
          flush=True)
    if open_browser:
        try:
            webbrowser.open(url)
        except Exception:
            pass

    deadline = time.time() + timeout
    try:
        while not state["done"] and time.time() < deadline:
            srv.handle_request()
    finally:
        srv.server_close()

    if state["result"] is None:
        return {"ok": False, "reason": "timeout", "method": "form",
                "hint": f"{timeout} 秒内未提交表单，已关闭端口"}
    out = dict(state["result"])
    out.setdefault("method", "form")
    return out


# --------------------------------------------------------------------------- #
# 凭据状态：使用 skill 的第一道门禁
# --------------------------------------------------------------------------- #
def auth_status(probe: bool = True) -> dict:
    """判断当前是否存在**有效**凭据，并给出下一步动作。

    只看本地 expires_at 不够：token 可能被平台提前吊销（实测扫码 token 会在 4 小时内
    被服务端作废），所以默认再向 `/human/member/center` 探活一次。同时报告本机是否
    保存了账号密码，好让调用方在需要登录时优先走方式三。
    """
    out = _auth_status(probe)
    out["login_methods"] = ["wechat_qr", "app_qr", "password"]
    if out["next_action"] == "need_login" and out.get("has_password"):
        out["next_action"] = "password_login"
        out["reason"] = (out["reason"] + "；" if out["reason"] else "") + \
            "本机已保存账号密码，可直接走方式三账密登录（免扫码、免验证码）"
    return out


def _auth_status(probe: bool = True) -> dict:
    out = {
        "valid": False,
        "source": None,                       # env / session / None
        "token_source": None,                 # app-login / qr-wechat / qr-app
        "expires_at": None,
        "remaining_seconds": None,
        "expired_locally": None,
        "probe_ok": None,                     # None=未探活
        "member": None,
        "has_password": CRED_FILE.exists(),
        "has_session_file": SESSION_FILE.exists(),
        "next_action": "need_login",          # skip_login / need_login
        "reason": "",
    }
    token = ""
    env = os.environ.get("MOOC_TOKEN", "").strip()
    if env:
        token, out["source"] = env, "env"
    elif SESSION_FILE.exists():
        try:
            obj = json.loads(SESSION_FILE.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            out["reason"] = f"会话文件损坏：{exc}"
            return out
        exp = obj.get("expires_at")
        out["expires_at"] = exp
        out["source"] = "session"
        out["token_source"] = obj.get("token_source")   # 端归属，401 排查用
        if exp:
            remain = (datetime.fromisoformat(exp) - datetime.now()).total_seconds()
            out["remaining_seconds"] = max(0, int(remain))
            out["expired_locally"] = remain <= 0
            if remain <= 0:
                out["reason"] = f"会话已于 {exp} 本地过期"
                return out
        try:
            token = _unprotect(obj.get("enc", "plain"), obj.get("token_b64", ""))
        except Exception as exc:
            out["reason"] = f"会话解密失败：{exc}"
            return out
        if not token:
            out["reason"] = "会话文件里没有可用 token"
            return out
    else:
        out["reason"] = "没有任何已保存的会话或 token"
        return out

    if probe:
        try:
            j = _get(api_session(token), "/human/member/center")
            out["probe_ok"] = True
            out["member"] = {
                "name": j.get("fullName"),
                "org": (j.get("organization") or {}).get("fullName"),
                "member_id": j.get("id"),
            }
        except SystemExit as exc:
            out["probe_ok"] = False
            out["reason"] = str(exc)
        except Exception as exc:                       # 网络异常，不把状态判成有效
            out["probe_ok"] = False
            out["reason"] = f"探活失败（{type(exc).__name__}）：{str(exc)[:120]}"

    out["valid"] = bool(token) and not out["expired_locally"] and out["probe_ok"] is not False
    if out["valid"] and probe and out["probe_ok"]:
        out["next_action"] = "skip_login"
        out["reason"] = "凭据有效，可直接进入阶段 2 采集任务"
    elif out["valid"]:
        # 只查了本地时间，不能据此免登录
        out["next_action"] = "need_probe"
        out["reason"] = "本地凭据未过期，但未向平台探活；请再运行 status（不带 --no-probe）确认"
    elif not out["reason"]:
        out["reason"] = "凭据无效"
    return out


def print_status(st: dict) -> None:
    print(f"凭据状态：{'有效 ✓' if st['valid'] else '无效 ✗'}")
    print(f"  来源：{ {'env': '环境变量 MOOC_TOKEN', 'session': '本地加密会话文件'}.get(st['source'], '无') }")
    if st.get("token_source"):
        side = {"app-login": "APP 端（账密登录）", "qr-wechat": "网页端（微信扫码）",
                "qr-app": "网页端（APP 扫码）"}.get(st["token_source"], st["token_source"])
        print(f"  端的来源：{side}")
    if st["expires_at"]:
        rem = st["remaining_seconds"]
        h, m = (rem // 3600, (rem % 3600) // 60) if rem is not None else (0, 0)
        print(f"  有效期至：{st['expires_at']}（剩余 {h} 小时 {m} 分）")
    if st["probe_ok"] is True and st["member"]:
        print(f"  平台探活：通过（{st['member']['name']} · {st['member']['org']}）")
    elif st["probe_ok"] is False:
        print("  平台探活：失败（token 可能已被平台吊销）")
    elif st.get("source") is None:
        print("  平台探活：跳过（没有可用凭据，谈不上探活）")
    else:
        print("  平台探活：未执行（--no-probe，结论仅基于本地时间）")
    print(f"  已保存账号密码：{'是' if st['has_password'] else '否'}")
    print(f"  原因：{st['reason']}")
    if st["next_action"] == "skip_login":
        print("  下一步：跳过登录，直接进入阶段 2 采集任务")
    elif st["next_action"] == "need_probe":
        print("  下一步：再运行一次 status（去掉 --no-probe）确认后才可免登录")
    elif st["next_action"] == "password_login":
        print("  下一步：走方式三账密登录（免扫码、免验证码，token 30 天）：")
        print("         $PY scripts/mooc_tasks.py login-password --password-stdin")
    elif st["has_password"]:
        print("  下一步：可尝试表单登录（仍需人工提供双因子验证码），或重新扫码")
    else:
        print("  下一步：方式三账密登录（需用户提供账号密码），或方式一/方式二扫码")


# --------------------------------------------------------------------------- #
# 学时总览
# --------------------------------------------------------------------------- #
# 两组学时各自独立考核，**不可互相抵扣**：
#   网络自学 = courseHourResult.totalHour / requireCourseHour
#   集中培训 = totalClassHour            / requireClassHour
HOUR_GROUPS = (
    ("网络自学", "courseHourResult.totalHour", "requireCourseHour",
     "网络课程/在线学习", "靠网络课程补；超额部分不能抵集中培训"),
    ("集中培训", "totalClassHour", "requireClassHour",
     "培训班/集中面授", "只能报班补；网络课程学时不计入这一组"),
)


def fetch_summary(s: requests.Session) -> dict:
    raw = _get(s, "/system/credit/detail-hour-member")
    course = raw.get("courseHourResult") or {}
    values = {"courseHourResult.totalHour": float(course.get("totalHour") or 0),
              "requireCourseHour": float(raw.get("requireCourseHour") or 0),
              "totalClassHour": float(raw.get("totalClassHour") or 0),
              "requireClassHour": float(raw.get("requireClassHour") or 0)}
    out: dict = {}
    for name, done_field, req_field, scene, how in HOUR_GROUPS:
        done, req = values[done_field], values[req_field]
        out[name] = {
            "已完成": round(done, 2),
            "要求": round(req, 2),
            # 差额为正=超额，为负=缺口；保留该键以兼容既有调用方
            "差额": round(done - req, 2),
            "缺口": round(max(0.0, req - done), 2),
            "完成率": round(done / req * 100, 1) if req else None,
            "达标": done >= req,
            "场景": scene,
            "字段": {"已完成": done_field, "要求": req_field},
            "补足方式": how,
        }
    total = raw.get("totalScore")
    out["总学分"] = total
    if total is not None:
        ssum = values["courseHourResult.totalHour"] + values["totalClassHour"]
        out["总学分校验"] = {
            "说明": "平台字段名为 totalScore，数值等于两组已完成学时之和，不是第三项独立指标",
            "两组之和": round(ssum, 2),
            "一致": abs(float(total) - ssum) < 0.011,
        }
    return out


def print_summary(sm: dict) -> None:
    print("学时总览（两组独立考核，不可互相抵扣）")
    for name, _, _, _, _ in HOUR_GROUPS:
        d = sm[name]
        gap = d["差额"]
        tail = f"超额 {gap:.2f}" if gap >= 0 else f"缺口 {-gap:.2f}"
        rate = f"，完成率 {d['完成率']:.1f}%" if d.get("完成率") is not None else ""
        flag = "已达标" if d["达标"] else "未达标"
        print(f"  {name}：已完成 {d['已完成']:.2f} / 要求 {d['要求']:.2f} 学时"
              f"（{d['场景']}）→ {tail}{rate} · {flag}")
        print(f"    字段：{d['字段']['已完成']} ÷ {d['字段']['要求']}")
        print(f"    {d['补足方式']}")
    v = sm.get("总学分校验") or {}
    if sm.get("总学分") is not None:
        print(f"  合计：{float(sm['总学分']):.2f} 学时"
              f"（平台字段 totalScore，= 两组已完成之和 {v.get('两组之和')}"
              f"，校验{'通过' if v.get('一致') else '不一致：字段含义已变，请重新核对'}）")


# --------------------------------------------------------------------------- #
# 任务采集与归一化
# --------------------------------------------------------------------------- #
def _ms_to_date(ms) -> str | None:
    if not ms:
        return None
    try:
        return datetime.fromtimestamp(int(ms) / 1000, tz=CN_TZ).date().isoformat()
    except (ValueError, OSError, OverflowError):
        return None


def _detail_url(bt: int, bid: str) -> str:
    tpl = URL_TEMPLATES.get(bt)
    return tpl.format(bid=bid) if tpl and bid else ""


def fetch_class_detail(s: requests.Session, class_id: str) -> dict:
    """班级（集中培训）详情：任务列表接口对班级只给 businessId，
    学时/起止/地点都在这里。缺了它，班级会被当成「4 学时、无截止」的网课排错。"""
    j = _get(s, f"/training/student/class-info/front/basic/{class_id}")
    return {
        "class_hour": float(j.get("classHour") or 0) or None,   # 集中培训学时
        "course_hour": float(j.get("classCourseHour") or 0),    # 其中网课部分，通常为 0
        "start": _ms_to_date(j.get("startTime")),
        "end": _ms_to_date(j.get("endTime")),
        "register_end": _ms_to_date(j.get("registerEndTime")),
        "place": (j.get("trainPlace") or "").strip(),
        # trainType: 0 线下 / 1 线上（现场页面文案与班级类型一致）
        "train_type": j.get("trainType"),
        "form": {0: "线下", 1: "线上"}.get(j.get("trainType"), "未标注"),
        "class_status": j.get("status"),
    }


def normalize(raw: dict, class_detail: dict | None = None) -> dict:
    """平台任务 -> tobacco.py 的 import 行。不输出 id，让任务库按 title+class_name 幂等去重。"""
    name = str(raw.get("name") or "").strip()
    bt = int(raw.get("businessType") or 0)
    kind = BUSINESS_KIND.get(bt, "other")
    bid = str(raw.get("businessId") or "")
    status = int(raw.get("status") or 1)
    start, end = _ms_to_date(raw.get("startTime")), _ms_to_date(raw.get("endTime"))
    expired = bool(raw.get("expired"))

    dur = raw.get("duration")
    estimated = False
    if isinstance(dur, (int, float)) and dur > 60:
        hours = round(dur / 3600, 2)
    else:
        hours = DEFAULT_HOURS.get(kind, 1.0)
        estimated = True

    place = ""
    if class_detail:
        # 班级以详情页为准：列表接口对班级 endTime/duration 恒为 null
        if class_detail.get("class_hour"):
            hours, estimated = class_detail["class_hour"], False
        start = class_detail.get("start") or start
        end = class_detail.get("end") or end
        place = class_detail.get("place") or ""

    label = BUSINESS_LABEL.get(bt, "其他")
    parts = [f"平台类型={label}(businessType={bt})",
             f"platform_id={raw.get('id', '')}",
             f"business_id={bid}"]
    if start:
        parts.append(f"开始={start}")
    if class_detail:
        parts.append(f"学时归属=集中培训（{class_detail.get('form')}）")
        if class_detail.get("course_hour"):
            parts.append(f"其中网课学时={class_detail['course_hour']}")
        if class_detail.get("register_end"):
            parts.append(f"报名截止={class_detail['register_end']}")
    if estimated:
        parts.append(f"时长为估值{hours}学时（平台未返回 duration）")
    if expired:
        parts.append("平台标记已过期")
    if status == 3:
        parts.append("平台已完成")

    return {
        "title": name,
        "kind": kind,
        # 学时归属：班级计集中培训（独立考核，网课学时不能抵扣）
        "credit_group": "集中培训" if bt == 5 else "网络自学",
        # sourceForm=1 是平台派发的必修；班级/培训班 sourceForm 恒为 null，但仍属必修
        "required": raw.get("sourceForm") == 1 or bt == 5,
        "deadline": end,
        "start": start,
        "place": place,
        "hours": hours,
        "progress": 100 if status == 3 else 0,
        "status": "done" if status == 3 else ("doing" if status == 2 else "todo"),
        "class_name": name if bt == 5 else "",
        "url": _detail_url(bt, bid),
        "platform_status": {1: "未开始", 2: "进行中", 3: "已完成"}.get(status, str(status)),
        "notes": "；".join(parts),
    }


def fetch_tasks(s: requests.Session, page_size: int = 200) -> list[dict]:
    j = _get(s, "/human/task", {"page": 1, "pageSize": page_size})
    items = j.get("items") or []
    total = j.get("recordCount", len(items))
    if total > len(items):   # 极端情况才分页兜底
        page = 2
        while len(items) < total:
            more = _get(s, "/human/task", {"page": page, "pageSize": page_size})
            rows = more.get("items") or []
            if not rows:
                break
            items += rows
            page += 1
    return items


def filter_scope(rows: list[dict], scope: str) -> list[dict]:
    """默认只保留真正需要安排的当前任务，避免 2020–2024 年的历史遗留淹没排期。"""
    today = cn_today().isoformat()
    if scope == "all":
        return rows
    if scope == "pending":
        return [r for r in rows if int(r.get("status") or 1) != 3]
    if scope == "year":
        year = str(cn_today().year)
        return [r for r in rows
                if (_ms_to_date(r.get("startTime")) or "").startswith(year)
                or (_ms_to_date(r.get("endTime")) or "").startswith(year)]
    # active：未完成 且（平台未标记过期 且 截止日不在过去）
    out = []
    for r in rows:
        if int(r.get("status") or 1) == 3:
            continue
        end = _ms_to_date(r.get("endTime"))
        if r.get("expired") or (end and end < today):
            continue
        out.append(r)
    return out


def build_payload(token: str, scope: str, s: requests.Session | None = None) -> dict:
    s = s or api_session(token)
    all_rows = fetch_tasks(s)
    chosen = filter_scope(all_rows, scope)
    rows = []
    for r in chosen:
        detail = None
        if int(r.get("businessType") or 0) == 5 and r.get("businessId"):
            # 班级的学时/截止只在详情接口，缺了就排不出正确日程
            try:
                detail = fetch_class_detail(s, str(r["businessId"]))
            except Exception:
                detail = None
        rows.append(normalize(r, detail))
    return {
        "tasks": rows,
        "meta": {
            "fetched_at": datetime.now().isoformat(timespec="seconds"),
            "scope": scope,
            "platform_total": len(all_rows),
            "selected": len(chosen),
            "summary": fetch_summary(s),
        },
    }


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #
def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="烟草网络学院学习任务采集 / 排期同步")
    sub = p.add_subparsers(dest="action", required=True)

    ss = sub.add_parser("session", help="保存 access_token 到加密的本地会话文件")
    ss.add_argument("--token", help="access_token；不推荐直接写在命令行（会进历史），可用 --token-stdin")
    ss.add_argument("--token-stdin", action="store_true",
                    help="从标准输入读 access_token，避免留存在 shell 历史里")
    ss.add_argument("--expires", type=int, default=14400, help="有效期秒数，默认 14400")
    ss.add_argument("--source", default="qr-wechat",
                    choices=["app-login", "qr-wechat", "qr-app", "unknown"],
                    help="这个 token 来自哪一端（app-login=APP 端；扫码=网页端）。"
                         "平台按端单会话，来源写错会导致排查 401 时判断错方向")

    lp = sub.add_parser("login-password",
                        help="方式三：账密登录（免扫码、免验证码，token 30 天）")
    lp.add_argument("--username", help="账号；不填则用本地已保存的账号")
    lp.add_argument("--password", help="密码；不推荐，会留在命令历史里")
    lp.add_argument("--password-stdin", action="store_true",
                    help="从标准输入读密码（推荐）")
    lp.add_argument("--company", default=None, help="单位名，默认「全行业」")
    lp.add_argument("--save-creds", action="store_true",
                    help="登录成功后把账号密码存到本地加密文件，下次免输")
    lp.add_argument("--json", action="store_true", help="输出结构化 JSON")

    lf = sub.add_parser("login-form",
                        help="方式三兜底：浏览器本地表单填账号密码（密码不进对话/命令历史）")
    lf.add_argument("--timeout", type=int, default=300, help="表单有效期秒数，默认 300")
    lf.add_argument("--no-open", action="store_true", help="不自动打开浏览器，只打印链接")
    lf.add_argument("--save-creds", action="store_true", help="登录成功后加密保存账号密码")
    lf.add_argument("--company", default=None, help="单位名，默认「全行业」")
    lf.add_argument("--json", action="store_true", help="输出结构化 JSON")

    sp_st = sub.add_parser("status", help="判断是否存在有效凭据（每次使用 skill 先跑）")
    sp_st.add_argument("--json", action="store_true", help="输出结构化 JSON 供 Agent 判断")
    sp_st.add_argument("--no-probe", action="store_true", help="只查本地过期时间，不向平台探活")

    sm = sub.add_parser("summary", help="查看网络自学 / 集中培训学时总览")
    sm.add_argument("--json", action="store_true", help="输出结构化 JSON")

    ft = sub.add_parser("fetch", help="拉取学习任务并输出归一化 JSON")
    ft.add_argument("--scope", choices=["active", "pending", "year", "all"], default="active")
    ft.add_argument("--out", help="写入文件；不填则打印到标准输出")
    ft.add_argument("--json", action="store_true", help="打印 JSON（默认）")

    sy = sub.add_parser("sync", help="拉取任务并直接导入本地任务库（幂等）")
    sy.add_argument("--scope", choices=["active", "pending", "year", "all"], default="active")
    sy.add_argument("--dry-run", action="store_true", help="只打印将要导入的任务，不写库")
    sy.add_argument("--keep-file", help="保留中间 JSON 到指定路径，便于排查")

    a = p.parse_args(argv)
    if a.action == "session":
        token = a.token
        if getattr(a, "token_stdin", False):
            token = sys.stdin.readline().strip()
        if not token:
            print("没有拿到 token：用 --token <token> 或 --token-stdin 从标准输入传入。")
            return 2
        print(json.dumps(save_session(token, a.expires, a.source), ensure_ascii=False))
        return 0

    if a.action == "login-form":
        res = login_form(timeout=a.timeout, open_browser=not a.no_open,
                         save_creds=a.save_creds, company=a.company)
        if a.json:
            print(json.dumps(res, ensure_ascii=False, indent=2))
        elif res.get("ok"):
            member = res.get("member") or {}
            print(f"登录成功（方式三 · 表单）：{member.get('name') or '（探活未通过）'}")
            if member.get("org"):
                print(f"  单位：{member['org']}")
            print(f"  有效期至：{res.get('expires_at')}")
            if res.get("creds_saved"):
                print(f"  凭据已保存：{res['creds_saved']}")
        else:
            print(f"未完成登录：{res.get('reason')}"
                  + (f"（{res['error']}）" if res.get("error") else ""))
        return 0 if res.get("ok") else 1

    if a.action == "login-password":
        from mooc_api import LoginError

        pwd = a.password
        if pwd is None and (a.password_stdin or not sys.stdin.isatty()):
            pwd = sys.stdin.readline().rstrip("\r\n") or None
        try:
            res = login_password(a.username, pwd, a.company)
        except LoginError as exc:
            out = {"ok": False, "login_method": "app-login", "code": exc.code,
                   "hint": exc.hint, "http_status": exc.http_status}
            print(json.dumps(out, ensure_ascii=False, indent=2) if a.json else
                  f"登录失败：[{exc.code or exc.http_status}] {exc.hint}")
            return 1
        if a.save_creds:
            if pwd:
                res["creds_saved"] = save_credentials(res["username"], pwd)
            else:
                res["creds_saved"] = "already-saved"
        if a.json:
            print(json.dumps(res, ensure_ascii=False, indent=2))
        else:
            who = res["member"]["name"] if res["member"] else "（探活未通过）"
            print(f"登录成功（方式三 · 账密）：{who}")
            if res["member"] and res["member"].get("org"):
                print(f"  单位：{res['member']['org']}")
            print(f"  有效期至：{res['expires_at']}（{res['expires_in'] // 86400} 天）")
            if res["probe_error"]:
                print(f"  警告：{res['probe_error']}")
            print("  下一步：进入阶段 2 采集任务")
        return 0 if res["ok"] else 1

    if a.action == "status":
        st = auth_status(probe=not a.no_probe)
        if a.json:
            print(json.dumps(st, ensure_ascii=False, indent=2))
        else:
            print_status(st)
        return 0 if st["valid"] else 1

    token, meta = load_session()
    s = api_session(token)

    if a.action == "summary":
        sm = fetch_summary(s)
        if getattr(a, "json", False):
            print(json.dumps({"session": meta, "summary": sm}, ensure_ascii=False, indent=2))
        else:
            print_summary(sm)
        return 0

    payload = build_payload(token, a.scope, s)
    tasks = payload["tasks"]
    if a.action == "fetch":
        text = json.dumps(payload, ensure_ascii=False, indent=2)
        if a.out:
            out = _safe_out(a.out)
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_text(text, encoding="utf-8")
            print(f"已写入 {out}：平台共 {payload['meta']['platform_total']} 条，"
                  f"本次选出 {len(tasks)} 条（scope={a.scope}）")
        else:
            print(text)
        return 0

    # sync
    if a.dry_run:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0
    if not tasks:
        print(f"scope={a.scope} 没有需要导入的任务，任务库未改动。")
        return 0

    tmp = _safe_out(a.keep_file) if a.keep_file else DATA_DIR / "mooc-import.json"
    tmp.parent.mkdir(parents=True, exist_ok=True)
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    try:
        r = subprocess.run([sys.executable, str(HERE / "tobacco.py"),
                            "task", "import", "--file", str(tmp)],
                           capture_output=True, text=True, encoding="utf-8",
                           timeout=120)
    except subprocess.TimeoutExpired:
        print("导入超时（120s）：tobacco.py task import 未返回，任务库可能未改动。")
        return 1
    print(r.stdout.strip() or r.stderr.strip())
    if not a.keep_file:
        tmp.unlink(missing_ok=True)
    print(f"平台共 {payload['meta']['platform_total']} 条任务，scope={a.scope} 导入 {len(tasks)} 条。")
    print_summary(payload["meta"]["summary"])
    return r.returncode


if __name__ == "__main__":
    try:
        sys.exit(main())
    except AuthExpired as exc:
        print(f"[会话] ⛔ {exc}", file=sys.stderr)
        print("[会话] 重新登录：python scripts/mooc_api.py qr wechat（扫码）"
              "或 python scripts/mooc_tasks.py login-pwd（账密）", file=sys.stderr)
        sys.exit(2)
