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
      账密默认读 .env (MOOC_USER/MOOC_PWD); 成功后 token 存 data/tokens/mooc_token.json
"""

import base64
import io
import itertools
import json
import os
import re
import secrets
import shutil
import sys
import time
import uuid as uuidlib

import requests
from Crypto.Cipher import AES


def utf8_stdio() -> None:
    """把 stdout/stderr 固定成 UTF-8 + errors=replace。

    Windows 上输出被重定向（CI、`> out.txt`、管道）时 Python 会用 ANSI 代码页，
    中文帮助/日志会直接 UnicodeEncodeError 崩掉；真控制台走 WriteConsoleW，不受影响。
    本模块是整条依赖链的最底层（mooc_client / auto_study / tasks / tui 都导入它），
    所以在导入时就生效。
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:  # pragma: no cover - pytest 捕获流不支持 reconfigure
            pass


utf8_stdio()

AES_KEY = b"d8cg8gVakEq9Agup"
LOGIN_URL = "https://mooc.ctt.cn/oauth/api/v1/app-login"
OAUTH = "https://mooc.ctt.cn/oauth/api/v1"
# 扫码通道（与 a 仓库 tobacco-mooc-study 同一套协议，见该仓库 references/api.md）
APP_QR_URL = OAUTH + "/deriveQRCode"        # GET  -> {uuid, data: base64 PNG}
APP_CHECK_URL = OAUTH + "/loginCheck"       # GET  -> {} 未扫 / 授权信息（含 access_token）
WX_CREATE_URL = OAUTH + "/createQRCode"     # POST -> {uuid}，图片由前端本地渲染
WX_CHECK_URL = OAUTH + "/checkUUIDStatus"   # POST -> {status, openId}
WX_AUTH_URL = OAUTH + "/weChat-auth"        # POST -> access_token
WECHAT_QR_TEMPLATE = "https://wx.zhixueyun.com/mswx/wechat/tobaccoQR/login/{uuid}/v5/online"
QR_HEADERS = {"X-Requested-With": "XMLHttpRequest", "Referer": "https://mooc.ctt.cn/oauth/",
              "User-Agent": "Mozilla/5.0 (Linux; Android 15; BSN-AN00) Mobile"}
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
# token 缓存放数据目录（TOBACCO_TOKEN_DIR → $TOBACCO_HOME/tokens → data/tokens），
# 不放脚本目录：仓库根下留一份 30 天有效的 access_token，一次 git add -A 就公开。
_TOKEN_DIR = (os.environ.get("TOBACCO_TOKEN_DIR")
              or os.path.join(os.environ.get("TOBACCO_HOME") or os.path.join(_SCRIPT_DIR, "data"),
                              "tokens"))


def _migrate_legacy_tokens():
    """旧版本把 mooc_token*.json 写在脚本目录，导入时搬到 _TOKEN_DIR（目标已存在则不覆盖）。"""
    if os.path.abspath(_TOKEN_DIR) == _SCRIPT_DIR:
        return
    try:
        names = [n for n in os.listdir(_SCRIPT_DIR)
                 if n.startswith("mooc_token") and n.endswith(".json")]
    except OSError:
        return
    for name in names:
        dst = os.path.join(_TOKEN_DIR, name)
        if os.path.exists(dst):
            continue
        try:
            os.makedirs(_TOKEN_DIR, exist_ok=True)
            shutil.move(os.path.join(_SCRIPT_DIR, name), dst)
        except OSError:
            pass


_migrate_legacy_tokens()


def token_file(user=None):
    """每个账号一个 token 缓存: default → mooc_token.json, 其他 → mooc_token.<名>.json"""
    if not user or user == "default":
        return os.path.join(_TOKEN_DIR, "mooc_token.json")
    safe = re.sub(r"[^\w-]+", "_", user)
    return os.path.join(_TOKEN_DIR, f"mooc_token.{safe}.json")


# 账密统一放 .env (不入库):
#   单账号: MOOC_USER / MOOC_PWD
#   多账号: MOOC_LOGIN / MOOC_PASS 两行一组, 追加任意多组 (无需命名, 显示名自动取平台真实姓名)
ENV_FILE = os.path.join(_SCRIPT_DIR, ".env")     # 仓库根那那份（data/.env 由 env_files() 兼容）


def env_files():
    """.env 候选文件，按优先级从高到低：

    1. `TOBACCO_ENV_FILE` 显式指定
    2. `$TOBACCO_HOME/.env`
    3. 当前工作目录 `.env`（标准做法：仓库根/项目根放一份）
    4. `data/.env`（历史位置，向后兼容）

    先加载的优先（`_load_dotenv` 用 setdefault，不覆盖已有环境变量）。
    """
    out = []
    explicit = os.environ.get("TOBACCO_ENV_FILE")
    if explicit:
        out.append(explicit)
    home = os.environ.get("TOBACCO_HOME")
    if home:
        out.append(os.path.join(home, ".env"))
    out.append(os.path.join(os.getcwd(), ".env"))
    out.append(ENV_FILE)
    return [p for i, p in enumerate(out) if p and p not in out[:i]]


def _env_items(path=None):
    """读 .env，产出 (key, value) —— 多文件时按优先级顺序拼接。"""
    paths = [path] if path else env_files()
    for candidate in paths:
        if not os.path.exists(candidate):
            continue
        with open(candidate, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                yield k.strip(), v.strip()


def _load_dotenv(path=None):
    """极简 .env 解析 (KEY=VALUE, # 注释), 不覆盖已存在的环境变量。"""
    for k, v in _env_items(path):
        os.environ.setdefault(k, v)


def _default_account():
    _load_dotenv()
    return os.environ.get("MOOC_USER", ""), os.environ.get("MOOC_PWD", "")


def _env_envfile_accounts(path=None):
    """解析 .env 中多账号组: MOOC_LOGIN/MOOC_PASS 两行一组, 无需任何命名。

    账号标识 = 用户名本身; 登录后由平台真实姓名做显示名(见 _all_accounts)。
    """
    out = []
    cur = None
    for k, v in _env_items(path):
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


def _token_only_accounts(known):
    """token 缓存里没有 .env 记录的账号 —— 扫码登录产生，没有账密可续期。"""
    out = []
    try:
        names = os.listdir(_TOKEN_DIR)
    except OSError:
        return out
    for name in sorted(names):
        if not (name.startswith("mooc_token") and name.endswith(".json")):
            continue
        # mooc_token.json 就是 default 账号：不能按姓名另起一个读不到的 key
        key = name[len("mooc_token."):-len(".json")] if name != "mooc_token.json" else "default"
        try:
            with open(os.path.join(_TOKEN_DIR, name), encoding="utf-8") as f:
                tok = json.load(f)
        except Exception:
            continue
        dn = tok.get("display_name")
        key = key or str(tok.get("userid") or "")
        if not tok.get("access_token") or not key or key in known:
            continue
        item = {"key": key, "username": dn or key, "qr_only": True}
        if dn:
            item["display_name"] = dn
        out.append(item)
    return out


def list_accounts():
    """返回 [{key, username, display_name?}]。display_name 为平台真实姓名(登录过才有)。"""
    out = []
    known = set()
    for a in _all_accounts():
        if not a.get("username"):          # pragma: no cover - 防御：解析层已过滤空账号
            continue
        item = {"key": a["key"], "username": a["username"]}
        if a.get("display_name"):
            item["display_name"] = a["display_name"]
        known.add(item["key"])
        out.append(item)
    out.extend(_token_only_accounts(known))
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


def account_has_password(key) -> bool:
    """该账号是否有可用的账密（扫码登录的账号没有）。"""
    for a in _all_accounts():
        if a.get("key") == key:
            return bool(a.get("username") and a.get("password"))
    return False


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


# ---------------------------------------------------------------- token 落盘

def _write_token(data, path, source=None):
    """写 token 缓存并补 login_time（mooc_client 用它算有效期，缺了会被当成旧格式）。

    source 记录 token 属于哪一端：app-login = APP 端会话；qr-app / qr-wechat = 网页端会话。
    平台按端单会话（enableUnique=1），两端 token 会互相顶下线，排查 401 时先看这个字段。
    """
    data = dict(data)
    data.setdefault("token_type", "Bearer")
    data["login_time"] = time.time()
    if source:
        data["token_source"] = source
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    return data


# ---------------------------------------------------------------- 扫码登录

def _session_key():
    """loginCheck / weChat-auth 的 key。

    实测（2026-11-04）服务端只校验非空：任意串与真实 hashKey 同样返回 200，
    故这里随机生成；若平台收紧，设环境变量 MOOC_HASH_KEY 换成登录页抓到的真值。
    """
    return os.environ.get("MOOC_HASH_KEY") or secrets.token_hex(16)


def _qr_issue(s, kind, save_dir=None):
    """取一张新码，返回 (uuid, png_bytes)。"""
    if kind == "app":
        r = s.get(APP_QR_URL, headers=QR_HEADERS, timeout=20)
        r.raise_for_status()
        body = r.json()
        return body["uuid"], base64.b64decode(body["data"])
    uid = str(uuidlib.uuid4())
    r = s.post(WX_CREATE_URL, params={"uuid": uid}, headers=QR_HEADERS, timeout=20)
    r.raise_for_status()
    uid = (r.json() or {}).get("uuid") or uid
    return uid, _render_qr(WECHAT_QR_TEMPLATE.format(uuid=uid))


class QRLoginError(RuntimeError):
    """扫码阶段可诊断的错误（例如已扫码但换取凭证失败）——要显示给用户，不能静默重试。"""


def _qr_check(s, kind, uid, key, on_error=None):
    """查一次扫码状态。已扫 → token dict；未扫 → None。"""
    if kind == "app":
        r = s.get(APP_CHECK_URL, params={"uuid": enc(uid), "organizationId": enc(1),
                                        "key": key}, headers=QR_HEADERS, timeout=20)
        body = r.json() if r.content else None
        return body if isinstance(body, dict) and body.get("access_token") else None
    r = s.post(WX_CHECK_URL, params={"uuid": uid}, headers=QR_HEADERS, timeout=20)
    body = r.json() if r.content else None
    if not isinstance(body, dict) or not body.get("status"):
        return None
    # openId 必须加密后提交（security:true）
    r = s.post(WX_AUTH_URL, data={"key": key, "organization_id": enc(1),
                                  "openId": enc(body.get("openId", ""))},
               headers=QR_HEADERS, timeout=20)
    tok = r.json() if r.content else None
    if isinstance(tok, dict) and tok.get("access_token"):
        return tok
    detail = ((tok or {}).get("message") or (tok or {}).get("errorCode")
              or (r.text or "")[:80] or f"HTTP {r.status_code}")
    msg = (f"微信已扫码，但换取凭证失败（{detail}）。"
           f"key 可能与登录会话不匹配：设 MOOC_HASH_KEY=<登录页抓到的 key> 后重试，或改用 APP 扫码")
    if on_error:
        on_error(msg)
    raise QRLoginError(msg)


def _render_qr(text, size=160):
    """本地渲染二维码（前端用 qrcodejs2，服务端对微信通道只登记不返图）。"""
    try:
        import qrcode
        from PIL import Image
        from qrcode.constants import ERROR_CORRECT_Q
    except ImportError as exc:
        raise SystemExit("缺少依赖：pip install qrcode pillow（uv 环境用 uv pip install qrcode pillow）") from exc
    qr = qrcode.QRCode(error_correction=ERROR_CORRECT_Q, box_size=10, border=2)
    qr.add_data(text)
    qr.make(fit=True)
    img = qr.make_image(fill_color="black", back_color="white").convert("RGB")
    img = img.resize((size, size), Image.NEAREST)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def qr_modules(png):
    """探测二维码真实模块数（含静区）。字符画必须 1 模块 1 字符，否则无法扫描。"""
    from PIL import Image
    img = Image.open(io.BytesIO(png)).convert("L")
    w, h = img.size
    px = img.load()
    runs = [len(list(g)) for _, g in itertools.groupby(
        1 if px[x, h // 2] < 128 else 0 for x in range(w))]
    side = max(1, min(runs))                       # 估计模块边长（像素）
    n = max(21, round(w / side))
    return n + (n % 2 == 0)                        # QR 模块数恒为奇数


def qr_ascii(png, max_width=None, invert=False):
    """把二维码 PNG 转成终端半块字符（一个字符容纳上下两个模块，比例接近方形）。

    **绝不缩放**：二维码一旦被降采样就扫不出来，所以 max_width 仅作参考，
    真实模块数超过它时照样按原尺寸输出（调用方应改用落盘的 PNG 或提示用户）。
    """
    try:
        from PIL import Image
    except ImportError as exc:
        raise SystemExit("缺少依赖：pip install qrcode pillow（uv 环境用 uv pip install qrcode pillow）") from exc
    n = qr_modules(png)
    img = Image.open(io.BytesIO(png)).convert("L").resize((n, n), Image.NEAREST)
    px = img.load()
    # 正色（默认）：白模块画成亮块、黑模块留空 —— 深色终端上这才是扫码器认的样子。
    # 反色（invert=True）：黑模块画成亮块，浅色终端/特殊扫码器时用。
    chars = ({(1, 1): "█", (1, 0): "▀", (0, 1): "▄", (0, 0): " "} if invert
             else {(0, 0): "█", (0, 1): "▀", (1, 0): "▄", (1, 1): " "})
    out = []
    for y in range(0, n, 2):
        out.append("".join(chars[(px[x, y] < 128,
                                  y + 1 < n and px[x, y + 1] < 128)] for x in range(n)))
    return "\n".join(out)


def qr_ascii_pair(png_a, png_b, max_width=33, gap="   ", invert=False):
    """APP / 微信两张二维码并排（半块字符），一次看全两条通道。

    单张最多 max_width 列；两图行数不同时用空行补齐，保证逐行对齐。
    """
    left = qr_ascii(png_a, max_width, invert).splitlines()
    right = qr_ascii(png_b, max_width, invert).splitlines()
    width = max([len(r) for r in left + right] or [0])
    height = max(len(left), len(right))
    left += [" " * width] * (height - len(left))
    right += [" " * width] * (height - len(right))
    return "\n".join(a.ljust(width) + gap + b.ljust(width) for a, b in zip(left, right))


def qr_ascii_stack(png_a, png_b, max_width=33, label_a="APP", label_b="微信"):
    """两张二维码上下排列（手机竖屏/窄终端用），比并排省一半宽度。"""
    left = qr_ascii(png_a, max_width).splitlines()
    right = qr_ascii(png_b, max_width).splitlines()
    width = max([len(r) for r in left + right] or [0])
    out = [label_a.center(width)]
    out += [r.ljust(width) for r in left]
    out += ["", label_b.center(width)]
    out += [r.ljust(width) for r in right]
    return "\n".join(out)


def qr_login(kind="app", user=None, ttl=55, cycles=3, interval=2.0,
             on_qr=None, save_dir=None, session=None, on_error=None):
    """扫码登录（kind: app=APP 扫一扫 / wechat=微信扫一扫），返回 (token, 账号key)。

    二维码约 55 秒失效，且两种通道都不给过期信号（未扫永远返回空），只能按 ttl
    本地计时换新码。on_qr(cycle, png, uid) 每轮回调一次，用于展示新码。
    """
    if kind not in ("app", "wechat"):
        raise ValueError("kind 只能是 app 或 wechat")
    key = _session_key()
    s = session or requests.Session()
    s.trust_env = False
    for cycle in range(1, cycles + 1):
        uid, png = _qr_issue(s, kind, save_dir)
        if on_qr:
            on_qr(cycle, png, uid)
        deadline = time.time() + ttl
        while time.time() < deadline:
            try:
                tok = _qr_check(s, kind, uid, key, on_error)
            except QRLoginError:
                raise                 # 已扫码但换票失败：立刻结束，让用户看到原因
            if tok:
                return _store_token(tok, user, kind)
            time.sleep(interval)
    raise RuntimeError(f"扫码登录超时（{cycles} 张码都未扫）：重新运行即可")


def qr_login_both(user=None, ttl=55, cycles=3, interval=2.0, on_qr=None, on_error=None):
    """同时跑 APP 与微信两路扫码，任一成功即返回 (token, 账号key, 成功通道)。

    两路各自换码/轮询；on_qr(kind, cycle, png, uid) 分别回调，便于并排展示。
    一路失败不影响另一路（最终两路都失败才抛错）。
    """
    import threading

    result: dict = {}
    stop = threading.Event()

    def worker(kind):
        def cb(cycle, png, uid):
            if on_qr and not stop.is_set():
                on_qr(kind, cycle, png, uid)
        try:
            tok, key = qr_login(kind, user=user, ttl=ttl, cycles=cycles,
                                interval=interval, on_qr=cb,
                                on_error=(lambda msg: on_error(kind, msg)) if on_error else None)
            if not stop.is_set():
                result.update(tok=tok, key=key, kind=kind)
                stop.set()                    # 一路成功，另一路尽快收手
        except BaseException as e:            # noqa: BLE001 - 记录后由主线程汇总
            result.setdefault("errors", []).append((kind, e))

    threads = [threading.Thread(target=worker, args=(k,), daemon=True)
               for k in ("app", "wechat")]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    if "tok" in result:
        return result["tok"], result["key"], result["kind"]
    errs = result.get("errors") or []
    raise RuntimeError("；".join(f"{k}: {e}" for k, e in errs) or "扫码登录超时")


def _store_token(tok, user=None, kind=None):
    """扫码拿到的 token 落盘。账号 key 优先用显式 user，否则取平台真实姓名。"""
    tok = dict(tok)
    if not tok.get("display_name"):
        dn = fetch_display_name(tok)
        if dn:
            tok["display_name"] = dn
    key = user or str(tok.get("userid") or "") or tok.get("display_name") or "qr"
    return _write_token(tok, token_file(key), f"qr-{kind}" if kind else None), key


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
    return _write_token(data, token_file(user), "app-login")


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


if __name__ == "__main__":  # pragma: no cover
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
    if args and args[0] == "qr":
        # 用法: qr [both|app|wechat] [账号] —— 默认 both：两张码并排，扫哪张都行
        kind = next((a for a in args[1:] if a in ("app", "wechat", "both")), "both")
        who = next((a for a in args[1:] if a not in ("app", "wechat", "both")), None)
        pngs = {}

        def show_side_by_side():
            print("\n" + "APP 扫码".center(29) + "   " + "微信扫码".center(29), flush=True)
            print(qr_ascii_pair(pngs["app"], pngs["wechat"], max_width=29), flush=True)

        def show_one(k, cycle, png):
            path = os.path.join(_TOKEN_DIR, f"mooc-qr-{k}.png")
            with open(path, "wb") as f:
                f.write(png)
            where = "APP → 右上角扫一扫" if k == "app" else "微信 → 右上角 + → 扫一扫"
            print(f"\n[{where}] 第 {cycle} 张 | 55 秒后自动换新 | 图片 {path}", flush=True)

        def show(k, cycle, png, uid):
            if kind == "both":
                pngs[k] = png
                show_one(k, cycle, png)
                if len(pngs) == 2:
                    show_side_by_side()
            else:
                show_one(k, cycle, png)
                print(qr_ascii(png), flush=True)

        if kind == "both":
            tok = qr_login_both(who, on_qr=show)
        else:
            def cb(cycle, png, uid):
                show(kind, cycle, png, uid)
            tok = qr_login(kind, who, on_qr=cb)
        _t, key = tok[0], tok[1]
        won = tok[2] if len(tok) > 2 else kind
        print(f"[OK] {'APP' if won == 'app' else '微信'}扫码登录成功，账号 {key}，"
              f"token 已存 {token_file(key)}")
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
