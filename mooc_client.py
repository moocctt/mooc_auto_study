#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
烟草网络学院 API 客户端 —— 凭证自动续期
========================================
在 mooc_api_login.py (协议逆向) 基础上封装:

  - 自动携带 Authorization: Bearer <access_token>
  - 本地检查 token 有效期(30天), 剩余不足1天自动重登
  - 请求遇 401 / errorCode 90901 / 90902 (凭证失效) 自动用保存的账密重登并重试一次
  - 全程无感, token 始终保存在 mooc_token.json

用法
----
  作为库:
      from mooc_client import api
      data = api("GET", "api/v1/system/setting")          # 相对路径或完整URL
      data = api("POST", "api/v1/xxx", json={...})

  命令行:
      python mooc_client.py GET  api/v1/system/setting
      python mooc_client.py POST api/v1/xxx '{"k":"v"}'
"""

import json
import os
import sys
import threading
import time

import requests

import mooc_api_login as m

BASE = "https://mooc.ctt.cn/"
# 凭证失效特征: HTTP 401, 或 body errorCode 为这些值 (源自前端拦截器处理逻辑)
AUTH_ERROR_CODES = {90901, 90902}
# 提前量: 剩余有效期不足 1 天就主动刷新
REFRESH_MARGIN = 86400

# 多用户: 当前账号名 (None = default, 读 .env); 用 set_user() 切换
CURRENT_USER = None
_LOCK = threading.Lock()


def set_user(name):
    """切换当前账号 (accounts.json 中的 name)。调用后所有 api() 走该账号的 token。"""
    global CURRENT_USER
    with _LOCK:
        CURRENT_USER = name or None


def get_user():
    return CURRENT_USER or "default"


def _token_file():
    return m.token_file(CURRENT_USER)


# ---------------------------------------------------------------- token 管理

def load_token_safe():
    """读取当前账号的 token 文件 (并发场景下的双检用), 失败返回 None。"""
    return _load()


def _load():
    if not os.path.exists(_token_file()):
        return None
    try:
        with open(_token_file(), encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def _save(tok):
    tok["login_time"] = time.time()
    with open(_token_file(), "w", encoding="utf-8") as f:
        json.dump(tok, f, ensure_ascii=False, indent=2)


def token_expired(tok):
    """本地判断: 无token / 缺字段 / 已超期(含提前量) → 需要刷新。"""
    if not tok or "access_token" not in tok:
        return True
    login_ts = tok.get("login_time", 0)
    expires_in = int(tok.get("expires_in", 2592000))
    if login_ts <= 0:               # 旧格式文件, 无法判断 → 按需由 401 兜底
        return False
    return time.time() - login_ts > expires_in - REFRESH_MARGIN


SOURCE_HINT = {
    "app-login": "APP 端会话",
    "qr-app": "网页端会话（APP 扫码）",
    "qr-wechat": "网页端会话（微信扫码）",
}


_SOURCE_LOGGED = False


def describe_source(tok) -> str:
    """当前 token 属于哪一端。平台按端单会话，两端会互相顶下线。"""
    src = (tok or {}).get("token_source") or "未知"
    return SOURCE_HINT.get(src, f"未知（{src}）")


def fresh_token(force=False):
    """返回可用 token dict; 必要时按当前账号自动重登。"""
    tok = _load()
    if force or token_expired(tok):
        print("[凭证] 过期/无效, 自动重新登录 ...")
        if CURRENT_USER and CURRENT_USER != "default":
            # 非默认账号只能用它自己的账密；否则会把 default 的 token 存到它名下（串号）
            if not m.account_has_password(CURRENT_USER):
                raise SystemExit(f"账号 {CURRENT_USER} 没有保存账密（扫码登录的账号），"
                                 "token 已过期。推荐改用账密登录（有效期 30 天）："
                                 "在 .env 写 MOOC_USER / MOOC_PWD，或 "
                                 "`python mooc_api_login.py <用户名> <密码>`；"
                                 "临时兜底可扫码：TUI 按 Q / `python mooc_api_login.py qr`")
            u, p = next((a["username"], a["password"])
                        for a in m._all_accounts() if a["key"] == CURRENT_USER)
        else:
            u, p = m.account_credentials(None)
        if not (u and p):
            # 扫码登录的账号没有账密可续期, 只能重新扫码
            raise SystemExit(f"账号 {get_user()} 没有保存账密。优先用账密登录"
                             "（有效期 30 天）：.env 写 MOOC_USER / MOOC_PWD，或 "
                             "`python mooc_api_login.py <用户名> <密码>`；"
                             "临时兜底可扫码：TUI 按 Q / `python mooc_api_login.py qr`")
        tok = m.login(u, p, user=CURRENT_USER)   # 内部已写对应 token 文件
        _save(tok)                                # 补记 login_time
        print("[凭证] 重新登录成功")
    global _SOURCE_LOGGED
    if tok and not _SOURCE_LOGGED:
        print(f"[会话] 来源 {describe_source(tok)}；平台按端单会话"
              f"（enableUnique=1），学习期间别在同端 App/网页里同时操作，否则会互相顶下线")
        _SOURCE_LOGGED = True
    if tok and not tok.get("display_name"):
        dn = m.fetch_display_name(tok)            # 平台真实姓名, 补进 token 缓存
        if dn:
            tok["display_name"] = dn
            _save(tok)
    return tok


def _headers(tok):
    # 注意格式: <token_type>__<access_token> (双下划线), "Bearer <token>" 会 401
    return {"Authorization": f"{tok.get('token_type','Bearer')}__{tok['access_token']}",
            "Accept": "application/json;charset=UTF-8",
            "X-Requested-With": "XMLHttpRequest"}


# ---------------------------------------------------------------- 请求封装

def api(method, path, params=None, json_body=None, data=None, _retry=True):
    """发起登录态请求; 凭证失效自动重登并重试一次。

    path: "api/v1/xxx" 相对路径 或 完整URL
    返回解析后的 JSON (非JSON时返回文本)。
    """
    url = path if path.startswith("http") else BASE + path.lstrip("/")
    tok = fresh_token()
    s = requests.Session()
    s.trust_env = False
    r = s.request(method.upper(), url, params=params, json=json_body, data=data,
                  headers=_headers(tok), timeout=25)

    need_refresh = (r.status_code == 401)
    if not need_refresh and "json" in r.headers.get("content-type", ""):
        try:
            body = r.json()
            if isinstance(body, dict) and body.get("errorCode") in AUTH_ERROR_CODES:
                need_refresh = True
        except Exception:
            pass

    if need_refresh and _retry:
        tok = fresh_token(force=True)
        r = s.request(method.upper(), url, params=params, json=json_body, data=data,
                      headers=_headers(tok), timeout=25)

    if "json" in r.headers.get("content-type", ""):
        try:
            return r.json()
        except Exception:
            pass
    return {"_status": r.status_code, "_text": r.text[:500]}


# ---------------------------------------------------------------- CLI

if __name__ == "__main__":  # pragma: no cover
    if len(sys.argv) < 3:
        sys.exit("用法: python mooc_client.py <GET|POST> <路径或URL> [JSON体]")
    method, path = sys.argv[1], sys.argv[2]
    body = json.loads(sys.argv[3]) if len(sys.argv) > 3 else None
    out = api(method, path, json_body=body)
    print(json.dumps(out, ensure_ascii=False, indent=2)[:3000])
