#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
烟草网络学院 (mooc.ctt.cn / 知学云 zxy_saas_mooc) 登录协议复现 —— 最终可用版
========================================================================
逆向来源:
  - APK assets/www 前端 JS (Cordova H5, 未加壳部分)
  - MCP 浏览器实测网页 oauth 流量

协议要点 (全部实测验证 2026-11-03)
--------------------------------
1. 接口:  POST https://mooc.ctt.cn/oauth/api/v1/app-login
2. 编码:  application/x-www-form-urlencoded (拦截器对 POST 强制 emulateJSON=true,
          不能用 JSON, 否则 HTTP 422 / errorCode 900000)
3. 加密:  body 中【每一个字段值】单独 AES-128-ECB(PKCS7) -> Base64
          key = b"d8cg8gVakEq9Agup"   (硬编码于 app.js 拦截器, module 165)
          空字符串原样传递 (前端 encrypt 对 falsy 直接返回)
4. 头:    X-Requested-With: XMLHttpRequest
          Accept: application/json;charset=UTF-8
          Authorization: (登录时无, 服务端不校验)
5. 响应:  {access_token, token_type:"Bearer", expires_in:2592000(30天),
           userid, loginToken}
6. 后续请求: Authorization: Bearer <access_token>

登录方式 login_method 取值: "login-by-user" (账密) / "login-by-mobile" (手机动态密码)

依赖: pip install pycryptodome requests
用法: python mooc_api_login.py [账号] [密码]
      账密默认读 .env (MOOC_USER/MOOC_PWD); 成功后 token 存 mooc_token.json
"""

import base64
import json
import os
import re
import sys

import requests
from Crypto.Cipher import AES

AES_KEY = b"d8cg8gVakEq9Agup"
LOGIN_URL = "https://mooc.ctt.cn/oauth/api/v1/app-login"
_TOKEN_DIR = os.path.dirname(os.path.abspath(__file__))


def token_file(user=None):
    """每个账号一个 token 缓存: default → mooc_token.json, 其他 → mooc_token.<名>.json"""
    if not user or user == "default":
        return os.path.join(_TOKEN_DIR, "mooc_token.json")
    safe = re.sub(r"[^\w-]+", "_", user)
    return os.path.join(_TOKEN_DIR, f"mooc_token.{safe}.json")


# 账密统一放 .env (不入库):
#   单账号: MOOC_USER / MOOC_PWD
#   多账号: MOOC_LOGIN / MOOC_PASS 两行一组, 追加任意多组 (无需命名, 显示名自动取平台真实姓名)
ENV_FILE = os.path.join(_TOKEN_DIR, ".env")


def _load_dotenv(path=None):
    """极简 .env 解析 (KEY=VALUE, # 注释), 不覆盖已存在的环境变量。"""
    path = path or ENV_FILE        # 调用时取值, 允许测试替换
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())


def _default_account():
    _load_dotenv()
    return os.environ.get("MOOC_USER", ""), os.environ.get("MOOC_PWD", "")


def _env_envfile_accounts(path=None):
    """解析 .env 中多账号组: MOOC_LOGIN/MOOC_PASS 两行一组, 无需任何命名。

    账号标识 = 用户名本身; 登录后由平台真实姓名做显示名(见 _all_accounts)。
    """
    path = path or ENV_FILE        # 调用时取值, 允许测试替换
    out = []
    if not os.path.exists(path):
        return out
    cur = None
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k, v = k.strip(), v.strip()
            if k == "MOOC_LOGIN":
                if cur is not None and cur.get("username"):
                    out.append(cur)
                cur = {"username": v, "password": ""}
            elif k == "MOOC_PASS" and cur is not None:
                cur["password"] = v
    if cur is not None and cur.get("username"):
        out.append(cur)
    for a in out:
        a["key"] = a["username"]       # 账号标识 = 用户名, 用户零命名负担
    return out


def _read_token(key=None):
    tf = token_file(key)
    if not os.path.exists(tf):
        return None
    try:
        with open(tf, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def _all_accounts():
    """合并 .env 多账号组 + .env 单账号(default)。

    每项: {key(=用户名, --user 用), username, password, display_name?}
    display_name = 登录后从平台拉到的真实姓名, 缓存在 token 文件里。
    """
    merged = {}
    for a in _env_envfile_accounts():
        merged[a["key"]] = a
    u, p = _default_account()
    if u:
        merged.setdefault("default", {"key": "default", "username": u, "password": p})
    for a in merged.values():
        try:
            tok = _read_token(a["key"])
            if tok and tok.get("display_name"):
                a["display_name"] = tok["display_name"]
        except Exception:
            pass
    return list(merged.values())


def list_accounts():
    """返回 [{key, username, display_name?}]。display_name 为平台真实姓名(登录过才有)。"""
    out = []
    for a in _all_accounts():
        if not a.get("username"):
            continue
        item = {"key": a["key"], "username": a["username"]}
        if a.get("display_name"):
            item["display_name"] = a["display_name"]
        out.append(item)
    return out


def account_credentials(key=None):
    """按 key(--user 值: 用户名/真实姓名均可, 支持前缀)取账密; 空或找不到回退 default。"""
    accs = _all_accounts()
    if key:
        for a in accs:
            if key in (a.get("key"), a.get("username"), a.get("display_name")):
                return a["username"], a["password"]
        for a in accs:
            for cand in (a.get("key"), a.get("username"), a.get("display_name")):
                if cand and cand.startswith(key):
                    return a["username"], a["password"]
    return _default_account()


def add_account(username, password):
    """新增账号到 .env (两行: MOOC_LOGIN/MOOC_PASS)。同用户名已存在时原地更新密码。"""
    lines = open(ENV_FILE, encoding="utf-8").read() if os.path.exists(ENV_FILE) else ""
    exists = any(a["username"] == username for a in _env_envfile_accounts())
    if exists:
        new_lines, cur, changed = [], None, False
        for line in lines.splitlines():
            ls = line.strip()
            k = ls.split("=", 1)[0].strip() if "=" in ls and not ls.startswith("#") else ""
            v = ls.split("=", 1)[1].strip() if "=" in ls and not ls.startswith("#") else ""
            if k == "MOOC_LOGIN":
                if cur is not None and cur.get("username"):
                    new_lines.extend(cur["lines"])
                cur = {"username": v, "password": "", "lines": [line]}
            elif k == "MOOC_PASS" and cur is not None:
                cur["password"] = v
                if cur["username"] == username:
                    cur["lines"] = [f"MOOC_LOGIN={username}", f"MOOC_PASS={password}"]
                    changed = True
                else:
                    cur["lines"].append(line)   # 原样保留其他账号的密码行
                new_lines.extend(cur["lines"])
                cur = None
            else:
                new_lines.append(line)
        if cur is not None and cur.get("username"):
            new_lines.extend(cur["lines"])
        if changed:
            with open(ENV_FILE, "w", encoding="utf-8") as f:
                f.write("\n".join(new_lines) + "\n")
            return ENV_FILE
    with open(ENV_FILE, "a", encoding="utf-8") as f:
        if lines and not lines.endswith("\n"):
            f.write("\n")
        f.write(f"MOOC_LOGIN={username}\nMOOC_PASS={password}\n")
    return ENV_FILE


def enc(v):
    """复现前端拦截器: 每个值 AES-128-ECB/PKCS7 -> Base64; 空值原样。"""
    if v is None:
        return None
    if v == "":
        return ""
    sv = ("true" if v else "false") if isinstance(v, bool) else str(v)
    d = sv.encode("utf-8")
    pad = 16 - len(d) % 16
    return base64.b64encode(AES.new(AES_KEY, AES.MODE_ECB).encrypt(d + bytes([pad]) * pad)).decode()


def dec(b64):
    """对应的解密 (调试用): 先解密, 再按明文最后一个字节的 PKCS7 填充长度去尾。"""
    d = AES.new(AES_KEY, AES.MODE_ECB).decrypt(base64.b64decode(b64))
    return d[:-d[-1]].decode("utf-8", "replace")


def login(username=None, password=None, company_name="全行业",
          terminal="Google Inc.", system="Linux armv8l", login_method="login-by-user",
          user=None):
    """user: 账号名(accounts.json 中的 name); 决定 token 缓存到哪个文件。"""
    if username is None or password is None:
        du, dp = account_credentials(user)
        username = username if username is not None else du
        password = password if password is not None else dp
    body = {
        "username": enc(username),
        "pword": enc(password),
        "company_name": enc(company_name),
        "login_method": enc(login_method),
        "client_id": enc(999),
        "displayDynamic": enc(True),
        "terminal": enc(terminal),
        "system": enc(system),
        "captcha": "",
    }
    s = requests.Session()
    s.trust_env = False  # 直连, 不走系统代理
    r = s.post(LOGIN_URL, data=body, timeout=20, headers={
        "Accept": "application/json;charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
        "User-Agent": "Mozilla/5.0 (Linux; Android 15; BSN-AN00) Mobile",
        "Origin": "https://mooc.ctt.cn",
        "Referer": "https://mooc.ctt.cn/oauth/",
    })
    if "json" not in r.headers.get("content-type", ""):
        raise RuntimeError(f"非JSON响应 HTTP {r.status_code}: {r.text[:200]}")
    data = r.json()
    if "access_token" not in data:
        raise RuntimeError(f"登录失败 HTTP {r.status_code}: {json.dumps(data, ensure_ascii=False)}")
    with open(token_file(user), "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    return data


def auth_headers(user=None):
    """读取已保存 token, 生成后续 API 请求头。"""
    with open(token_file(user), encoding="utf-8") as f:
        t = json.load(f)
    return {"Authorization": f"{t.get('token_type','Bearer')} {t['access_token']}"}


CENTER_URL = "https://mooc.ctt.cn/api/v1/human/member/center"


def fetch_display_name(token_resp):
    """登录后拉取平台真实姓名 (fullName), 失败返回 None。"""
    try:
        s = requests.Session()
        s.trust_env = False
        r = s.get(CENTER_URL, timeout=15, headers={
            "Authorization": f"{token_resp.get('token_type', 'Bearer')}__{token_resp['access_token']}",
            "Accept": "application/json;charset=UTF-8",
            "X-Requested-With": "XMLHttpRequest"})
        if "json" in r.headers.get("content-type", ""):
            d = r.json()
            return d.get("fullName") or d.get("name")
    except Exception:
        pass
    return None


if __name__ == "__main__":
    args = sys.argv[1:]
    if args and args[0] == "add":
        # 用法: add <用户名> <密码>  —— 无需命名, 显示名自动取平台真实姓名
        if len(args) < 3:
            sys.exit("用法: python mooc_api_login.py add <用户名> <密码>")
        username, password = args[1], args[2]
        path = add_account(username, password)
        print(f"[OK] 账号 {username} 已写入 {path}")
        print("[后续] python mooc_api_login.py " + username + "  即可登录该账号")
        sys.exit(0)
    if args and args[0] == "list":
        accs = list_accounts()
        print(f"共 {len(accs)} 个账号:")
        for a in accs:
            dn = a.get("display_name")
            who = f"  真实姓名: {dn}" if dn else ""
            print(f"  - {a['key']}  ({a['username']}){who}")
        sys.exit(0)

    accounts = list_accounts()
    if args and args[0] in [a["key"] for a in accounts]:
        user = args[0]
        usr, pwd = account_credentials(user)
    else:
        user = None
        du, dp = _default_account()
        usr = args[0] if args else du
        pwd = args[1] if len(args) > 1 else dp
    resp = login(usr, pwd, user=user)
    dn = fetch_display_name(resp)
    show = dict(resp)
    for k in ("access_token", "loginToken"):
        if k in show:
            show[k] = show[k][:10] + "..."
    print(json.dumps(show, ensure_ascii=False, indent=2))
    print(f"\n[OK] 登录成功({user or 'default'}), 完整token已存 {token_file(user)}")
    if dn:
        print(f"[用户] {dn}")
    print("[后续] 请求头: Authorization: Bearer <access_token>")
