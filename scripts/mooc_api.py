#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""中国烟草网络学院（mooc.ctt.cn）OAuth API 客户端 —— 纯 HTTP，不依赖浏览器。

2026-11-04 经真实抓包验证（Playwright 网络捕获 + 字节级复现比对 + 二维码解码回验）：

  OAuth 页面: https://mooc.ctt.cn/oauth/#login/<base64(OAuth参数)>
    默认参数 response_type=token&client_id=999&redirect_uri=https://mooc.ctt.cn&state=/home
  参数加密: AES-128-ECB + PKCS7，密钥硬编码于前端 key-config: d8cg8gVakEq9Agup
    校验方法: aes_encrypt("1") 必须 == "N8XxZPBkHR4UcAuMtuMC4Q=="

两条扫码通道（互不相同，务必区分）：

  ┌ APP 扫码 ─────────────────────────────────────────────────────┐
  │ GET  /oauth/api/v1/deriveQRCode                               │
  │  -> {uuid, data: <base64 PNG>}   二维码由服务端直接下发         │
  │ 轮询 GET /oauth/api/v1/loginCheck?uuid=&organizationId=&key=   │
  │    （uuid / organizationId 需 AES 加密，key 为会话串）          │
  └───────────────────────────────────────────────────────────────┘

  ┌ 微信扫码 ─────────────────────────────────────────────────────┐
  │ POST /oauth/api/v1/createQRCode?uuid=<前端生成的 uuid>         │
  │  -> {uuid}   服务端只登记 uuid，不下发图片                      │
  │ 二维码内容由前端 qrcodejs2 本地渲染，模板为：                   │
  │   https://wx.zhixueyun.com/mswx/wechat/tobaccoQR/login/        │
  │        <uuid>/v5/<ds>                                          │
  │   ds 按域名取值: online(默认) / test / publicTest / dev / gd    │
  │ 轮询 POST /oauth/api/v1/checkUUIDStatus?uuid=<uuid>（明文参数） │
  │   {status:true, openId} -> 已扫码；{code:"0002"} -> 需刷新      │
  │ 换票 POST /oauth/api/v1/weChat-auth                            │
  │   {key: hashKey, organization_id, openId}  security:true       │
  │   -> {redirect_uri, access_token, token_type, expires_in, state}│
  └───────────────────────────────────────────────────────────────┘

有效期：前端 checkUUIDStatus 只轮询 10 次 × 5 秒即显示「二维码已失效」，
故两种二维码均约 50–60 秒过期，过期后必须重新生成（脚本内置自动刷新）。

三种登录方式（互不相同）：

  ┌ 方式一 / 方式二：扫码 ────────────────────────────────────────┐
  │ 微信码、APP 码，见上方两条通道                                │
  └───────────────────────────────────────────────────────────────┘

  ┌ 方式三：账密登录（APP 通道，推荐）─────────────────────────────┐
  │ POST /oauth/api/v1/app-login                                  │
  │  form-urlencoded；每个字段值单独 AES-128-ECB 加密              │
  │  必填: username pword login_method company_name client_id     │
  │  login_method = login-by-user（账密）/ login-by-mobile         │
  │  不需要会话 key、不需要验证码，返回 access_token 有效期 30 天   │
  └───────────────────────────────────────────────────────────────┘

其余接口：
  POST /oauth/api/v1/auth        网页端表单登录（key/organization_id/login_method/username/pword/captcha）
  GET  /oauth/api/v1/setting?key=<b64(OAuth参数)>   登录页配置（weChatLogin/doubleValidate）
  GET  /oauth/api/v1/skin?organizationId=&clientType=1&language=1

登录成功后为 OAuth2 隐式流：redirect_uri#access_token=...&token_type=Bearer&expires_in=...

仅用于本人账号的登录与学习任务管理；不自动播放课程、不绕过平台限制。
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re

import sys
import time
import uuid as uuidlib
from html import escape
from pathlib import Path

import requests
from Crypto.Cipher import AES
from Crypto.Util.Padding import pad

try:                        # 中文帮助/输出在 Windows 重定向时会被 ANSI 代码页打死（见 tobacco.utf8_stdio）
    from tobacco import utf8_stdio as _utf8_stdio

    _utf8_stdio()
    del _utf8_stdio
except Exception:           # pragma: no cover
    pass

BASE = "https://mooc.ctt.cn"
API = BASE + "/oauth/api/v1"


def mask_token(token) -> str:
    """只露前 10 位：access_token 不能整颗进日志、终端输出或对话记录。"""
    s = str(token or "")
    if not s:
        return "***"
    return s[:10] + "..." if len(s) > 10 else "..."


def _login_ok(body) -> bool:
    """登录成功的唯一判据：响应里真有 access_token。

    平台会把“换票被拒”也以 200 返回（body 里是 errorCode），所以不检查这一点
    就会出现“扫码成功但没会话”。
    """
    return isinstance(body, dict) and bool(body.get("access_token"))


_TOKEN_FIELD_RE = re.compile(
    r'("(?:access_token|loginToken|refresh_token)"\s*:\s*")([^"]{0,10})[^"]*(")')


def redact_text(text: str) -> str:
    """把响应原文里的凭证字段打码：这些整段回显给用户的路径不能漏 token。"""
    return _TOKEN_FIELD_RE.sub(r"\1\2…\3", str(text or ""))


AES_KEY = b"d8cg8gVakEq9Agup"          # 前端 key-config.aeskey；平台改版后需重新抓取
AES_FINGERPRINT = "N8XxZPBkHR4UcAuMtuMC4Q=="   # aes_encrypt("1")，用于自检密钥是否失效
ORG_ID = "1"

# 登录页首屏 GET /setting?key=<...> 用的固定值（main-*.js）。服务端把它与
# cookie 会话绑定，之后同一会话的 weChat-auth 换票 key 必须就是这个值
# （AES 加密传输）。因此它是"真实 hashKey"，不需要也不能随机。
OAUTH_SETTING_KEY = base64.b64encode(
    b"response_type=token&client_id=999&redirect_uri=https%3A%2F%2Fmooc.ctt.cn"
    b"&state=%2Fhome&lang=cn&cancelRememberState=0").decode()
USER_AGENT = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")

WECHAT_QR_TEMPLATE = ("https://wx.zhixueyun.com/mswx/wechat/tobaccoQR/login/"
                      "{uuid}/v5/{ds}")

# 账密登录（APP 通道）固定参数。company_name 是本组织后台的显示名，写错不会报错但可能取不到组织，
# 实测「全行业」可用；换单位时可通过命令行覆盖。
APP_LOGIN_COMPANY = "全行业"
APP_LOGIN_TERMINAL = "Google Inc."
APP_LOGIN_SYSTEM = "Linux armv8l"
APP_LOGIN_TTL = 2592000                # 30 天，APP 通道下发的 expires_in
LOGIN_METHODS = {"user": "login-by-user", "mobile": "login-by-mobile"}

# 服务端错误码 -> 人话。HTTP 状态码不可靠：账密错误同样返回 422，且响应不带 Content-Type。
LOGIN_ERRORS = {
    "900000": "请求参数缺失或未按规则加密（检查 Content-Type 是否为 form-urlencoded、字段值是否逐个加密）",
    "90105": "账号格式不正确：平台按手机号/工号校验，不要填姓名或邮箱",
    "90908": "账号或密码不正确",
    "90907": "账号或密码校验未通过（连续失败后常出现，疑似触发了频率限制）",
    "90904": "账号或密码不正确",
    "900001": "登录过于频繁，请稍后再试",
}


def aes_encrypt(plain: str) -> str:
    """与前端 ./app/util/aes 完全一致：AES-128-ECB + PKCS7 + base64。空值原样返回。"""
    if plain in ("", None):
        return plain
    cipher = AES.new(AES_KEY, AES.MODE_ECB)
    return base64.b64encode(cipher.encrypt(pad(str(plain).encode("utf-8"), 16))).decode()


def site_channel(host: str = "mooc.ctt.cn") -> str:
    """前端按下发域名决定二维码的 ds 段。"""
    if "moocdev9" in host:
        return "dev"
    if "mooctest9" in host:
        return "test"
    if "mooc5" in host:
        return "publicTest"
    if "smooc" in host or "imooc" in host:
        return "gd"
    return "online"


def _save(path: str | Path | None, data: bytes) -> None:
    """写文件前确保父目录存在；图片可能含登录凭据（二维码即临时凭据），顺便收紧权限。"""
    if not path:
        return
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(data)
    try:
        from tobacco import _restrict_permissions
        _restrict_permissions(p)
    except Exception:
        pass


SKILL_ROOT = Path(__file__).resolve().parent.parent
TEMPLATE_DIR = SKILL_ROOT / "templates"


def _template(name: str) -> str:
    try:
        return (TEMPLATE_DIR / name).read_text(encoding="utf-8")
    except OSError:
        return ""


def fill_template(text: str, mapping: dict) -> str:
    """把 {{KEY}} 占位符换成值；未提供的键不报错，渲染成空串。"""
    for k, v in mapping.items():
        text = text.replace("{{" + k + "}}", str(v))
    return re.sub(r"\{\{[A-Z_0-9]+\}\}", "", text)


def render_qr_widget(png: bytes, *, title: str, hint: str, ttl: int,
                     uid: str = "") -> str:
    """二维码 widget：把 PNG 内联成 data URI，交给 show_widget 直接展示。

    宿主对 file:// 与本地路径都不放行，内联 data URI 是唯一能稳定显示的方式；
    模板里刻意不含 JS（沙箱渲染带脚本的 widget 会长时间卡在"渲染中"，
    用户因此错过 1 分钟有效期）。
    """
    b64 = base64.b64encode(png).decode("ascii")
    px = 176
    try:                                    # 按实际像素展示，避免 CSS 缩放糊掉模块边缘
        import io as _io
        from PIL import Image as _Image
        px = int(_Image.open(_io.BytesIO(png)).size[0])
    except Exception:
        pass
    qr_block = (f'<img src="data:image/png;base64,{b64}" alt="{escape(title)}" '
                f'style="width:{px}px; height:{px}px; border-radius:8px; '
                'image-rendering: pixelated; display:block;">')
    tpl = _template("qr-widget.html")
    if tpl.strip().startswith("<!--"):
        tpl = tpl.split("-->", 1)[1].lstrip() if "-->" in tpl else tpl
    return fill_template(tpl, {"B64": b64, "TITLE": escape(title),
                               "HINT": escape(hint), "TTL": int(ttl),
                               "PX": px,
                               "UUID": (uid or "")[:8]}) if tpl else (
        '<div style="font-size:14px;">'
        + qr_block + f"<p>{escape(title)}</p><p>{escape(hint)}</p></div>")


def render_login_widget(*, title: str = "登录烟草网络学院", hint: str = "",
                        account: str = "", ttl: int = 55,
                        png: bytes | None = None, uid: str = "") -> str:
    """登录卡片：二维码 + 下一步说明。没码时只显示表单/提示（账密登录入口）。"""
    qr_block = render_qr_widget(png, title="扫码登录", hint="用微信或学院 APP 扫一扫",
                                ttl=ttl, uid=uid) if png else ""
    tpl = _template("login-widget.html")
    if not tpl.strip():                        # 模板缺失/没提交进仓库：给内联兜底，不安静输出空卡片
        print("⚠️  templates/login-widget.html 缺失，登录卡片用内联模板", file=sys.stderr)
        tpl = ("<div style=\"padding:1.1rem 1.25rem;border:0.5px solid #ddd;"
               "border-radius:12px;max-width:560px;font-size:14px;\">"
               "{{QR_BLOCK}}<p style=\"font-size:15px;font-weight:500;\">{{TITLE}}</p>"
               "<p style=\"color:#555;\">{{HINT}}</p><p>账号：<strong>{{ACCOUNT}}</strong></p>"
               "<p style=\"color:#888;font-size:12px;\">二维码 {{TTL}} 秒内有效，过期自动换新码。</p></div>")
    if tpl.strip().startswith("<!--"):
        tpl = tpl.split("-->", 1)[1].lstrip() if "-->" in tpl else tpl
    return fill_template(tpl, {"QR_BLOCK": qr_block, "TITLE": escape(title),
                               "HINT": escape(hint),
                               "ACCOUNT": escape(account or "未提供"),
                               "TTL": int(ttl)})


def widget_script(html: str) -> str:
    """单文件 HTML：本地双击就能看（不依赖宿主 widget 能力）。"""
    return ("<!doctype html><meta charset=\"utf-8\">"
            "<title>烟草网络学院 · 扫码登录</title>"
            "<body style=\"margin:24px;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;"
            "background:#f6f7f9;\">" + html + "</body>")


def ascii_qr(text: str) -> str:
    """终端兜底：用半格字符直接打印二维码（宿主没有 widget 能力时用）。"""
    try:
        import qrcode
        from qrcode.constants import ERROR_CORRECT_Q
    except ImportError as exc:  # pragma: no cover
        raise SystemExit("缺少依赖：pip install qrcode pillow") from exc
    qr = qrcode.QRCode(error_correction=ERROR_CORRECT_Q, border=2)
    qr.add_data(text)
    qr.make(fit=True)
    m = qr.get_matrix()
    blank = "  "
    fill = "██"
    return "\n".join("".join(fill if c else blank for c in row) for row in m)


def render_qr(text: str, size: int = 160, out: str | Path | None = None) -> bytes:
    """本地渲染二维码（与前端 qrcodejs2 一致：纠错等级 Q）。

    先用 box_size=1 量出模块数，再按**整数倍**重画：每个模块固定占 N 个像素，
    比「大图缩到 160px」更锐利（缩放在非整数倍时会让模块宽窄交替，影响识别），
    同时省掉一次大图生成。
    """
    try:
        import qrcode
        from qrcode.constants import ERROR_CORRECT_Q
    except ImportError as exc:  # pragma: no cover
        raise SystemExit("缺少依赖：pip install qrcode pillow") from exc

    from PIL import Image

    probe = qrcode.QRCode(error_correction=ERROR_CORRECT_Q, box_size=1, border=2)
    probe.add_data(text)
    probe.make(fit=True)
    modules = probe.modules_count + 4          # 含 2 格静区
    box = max(1, size // modules)              # 整数倍，宁小不大
    qr = qrcode.QRCode(error_correction=ERROR_CORRECT_Q, box_size=box, border=2)
    qr.add_data(text)
    qr.make(fit=True)
    img = qr.make_image(fill_color="black", back_color="white").convert("RGB")
    # 只有整数倍才是锐利的：非整数倍缩放会让模块宽窄交替，微信扫不出来
    edge = modules * box
    if img.size[0] != edge:
        img = img.resize((edge, edge), Image.NEAREST)
    import io
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    data = buf.getvalue()
    _save(out, data)
    return data


def decode_qr(path_or_bytes) -> str | None:
    """可选自检：解出图片里的二维码内容。需要 zxing-cpp。"""
    try:
        import io

        import zxingcpp
        from PIL import Image
    except ImportError:
        return None
    if isinstance(path_or_bytes, (bytes, bytearray)):
        img = Image.open(io.BytesIO(path_or_bytes))
    else:
        img = Image.open(path_or_bytes)
    res = zxingcpp.read_barcodes(img)
    return res[0].text if res else None


class LoginError(RuntimeError):
    """账密登录被服务端拒绝。code 为平台 errorCode，hint 是可直接展示给用户的中文说明。"""

    def __init__(self, code: str, message: str, http_status: int | None = None,
                 payload: dict | None = None):
        self.code = str(code or "")
        self.message = message
        self.http_status = http_status
        self.payload = payload or {}
        self.hint = LOGIN_ERRORS.get(self.code) or (
            f"平台返回错误码 {self.code}（{message or '无描述'}），"
            "请核对账号密码，或改用扫码登录" if self.code
            else (message or "登录失败"))
        super().__init__(f"[{self.code or 'HTTP %s' % http_status}] {self.hint}")


class MoocAuth:
    def __init__(self, session_key: str | None = None, timeout: int = 20):
        self.s = requests.Session()
        self.s.headers.update({
            "User-Agent": USER_AGENT,
            "Origin": BASE,
            "Referer": BASE + "/oauth/",
            "X-Requested-With": "XMLHttpRequest",
        })
        self.timeout = timeout
        # weChat-auth 换票的 key 规则（实测得出，2026-11-05）：
        #   1. security:true 的 POST 请求所有字段都 AES 加密 —— key 也必须加密；
        #   2. key 的"值"必须是本 cookie 会话在 GET /setting?key=<...> 时用过的
        #      同一个值（服务端把 setting 的 key 与会话绑定，换票时校验一致性）。
        # 前端的这个值就是登录页首屏 /setting 请求里的 base64(OAuth参数)，是
        # 固定常量。因此默认用它，并在换票前先 bootstrap() 登记 —— 不必开浏览器。
        if session_key:
            self.session_key = session_key
            self.generated_key = False
        else:
            self.session_key = OAUTH_SETTING_KEY
            self.generated_key = False
        self.uuid: str | None = None       # APP 扫码的 uuid（服务端下发）
        self.wechat_uuid: str | None = None
        self.wechat_url: str | None = None
        self._bootstrapped = False             # /setting 是否已在本会话登记过 key
        self._dead_openids: set[str] = set()   # 换票被永久拒绝的 openId，不重复打接口

    # ------------------------------------------------------------------ #
    def _warmup(self) -> None:
        if not self.s.cookies:
            self.s.get(BASE + "/oauth/", timeout=self.timeout)

    def bootstrap(self) -> dict:
        """取登录页配置与皮肤，并把 OAUTH_SETTING_KEY 登记到本 cookie 会话。

        weChat-auth 换票前必须先执行（同会话、同 key 值），否则真 openId
        会被服务端以 422 90101 "Invalid input." 拒绝。
        """
        self._warmup()
        cfg = self.s.get(API + "/setting",
                         params={"key": OAUTH_SETTING_KEY},
                         timeout=self.timeout).json()
        self.s.get(API + "/skin",
                   params={"organizationId": ORG_ID, "clientType": 1, "language": 1},
                   timeout=self.timeout)
        self._bootstrapped = True
        return cfg

    # ------------------------- 通道一：APP 扫码 ------------------------- #
    def fetch_app_qr(self, save_to: str | Path | None = None) -> bytes:
        """APP 扫码登录二维码。服务端直接返回 PNG，无需本地渲染。"""
        self._warmup()
        r = self.s.get(API + "/deriveQRCode", timeout=self.timeout).json()
        self.uuid = r["uuid"]
        png = base64.b64decode(r["data"])
        _save(save_to, png)
        return png

    def probe_app(self) -> dict:
        """单次查询 APP 扫码状态。未扫码返回 {}，已扫码返回授权信息。"""
        if not self.uuid:
            raise RuntimeError("先调用 fetch_app_qr()")
        if not self.session_key:
            raise RuntimeError("缺少会话 key（hashKey）：请先从真实登录页抓取任一 security 请求的 key")
        r = self.s.get(API + "/loginCheck",
                       params={"uuid": aes_encrypt(self.uuid),
                               "organizationId": aes_encrypt(ORG_ID),
                               "key": self.session_key},
                       timeout=self.timeout)
        txt = r.text.strip()
        if r.status_code != 200 or not txt or txt in ("{}", "null"):
            return {}
        try:
            return r.json()
        except ValueError:
            return {"raw": txt[:300]}

    def poll_app_login(self, max_seconds: int = 120, interval: float = 3.0) -> dict | None:
        """轮询 APP 扫码结果。返回登录信息（含 access_token），超时返回 None。

        注意：APP 通道没有过期信号，未扫码永远返回 {}，超时只能靠调用方计时。
        """
        deadline = time.time() + max_seconds
        while time.time() < deadline:
            data = self.probe_app()
            if data:
                return data
            time.sleep(interval)
        return None

    # ------------------------- 通道二：微信扫码 ------------------------- #
    def create_wechat_qr(self, save_to: str | Path | None = None,
                         channel: str | None = None) -> tuple[str, bytes]:
        """微信扫码登录二维码。

        返回 (二维码内容 URL, PNG 字节)。注意：服务端只登记 uuid，
        图片由前端用 qrcodejs2 本地渲染，因此这里同样本地生成。
        """
        self._warmup()
        self.wechat_uuid = str(uuidlib.uuid4())
        r = self.s.post(API + "/createQRCode",
                        params={"uuid": self.wechat_uuid}, timeout=self.timeout)
        if r.status_code != 200:
            raise RuntimeError(f"createQRCode 失败: {r.status_code} {r.text[:200]}")
        body = r.json()
        # 服务端可能回传自己的 uuid，以前端提交值为准（二维码内容用的就是它）
        self.wechat_uuid = body.get("uuid") or self.wechat_uuid
        self.wechat_url = WECHAT_QR_TEMPLATE.format(
            uuid=self.wechat_uuid, ds=channel or site_channel())
        png = render_qr(self.wechat_url, 160, save_to)
        return self.wechat_url, png

    def probe_wechat(self) -> dict:
        """单次查询微信扫码状态。未扫码 {}，已扫码含 status/openId，失效为 code=0002。"""
        if not self.wechat_uuid:
            raise RuntimeError("先调用 create_wechat_qr()")
        r = self.s.post(API + "/checkUUIDStatus",
                        params={"uuid": self.wechat_uuid}, timeout=self.timeout)
        txt = r.text.strip()
        if not txt or txt in ("null", "{}"):
            return {}
        try:
            return r.json()
        except ValueError:
            return {"raw": txt}

    def poll_wechat_status(self, max_seconds: int = 60, interval: float = 2.0) -> dict | None:
        """轮询微信扫码状态。

        返回 {"status": True, "openId": ...} 表示已扫码；
             {"expired": True} 表示需刷新（约 50–60 秒失效）。
        """
        deadline = time.time() + max_seconds
        while time.time() < deadline:
            data = self.probe_wechat()
            if data.get("code") == "0002":
                return {"expired": True}
            if data.get("status"):
                return data
            time.sleep(interval)
        return None

    def wechat_auth(self, open_id: str) -> requests.Response:
        """微信扫码换票（security:true，**所有字段**需 AES 加密）。

        前端框架（main-*.js 的请求层）对 security:!0 请求把 data 里的
        **每一个字段**都 encrypt —— 包括 key。只加密 organization_id/openId、
        key 加密修复（security 请求全字段加密）之外还要求：本 cookie 会话必须
        先经 bootstrap() 用同一个 key 值调过 /setting，否则真 openId 会被
        422 90101 拒绝（假 openId 只会走到 90144，测不出这一层）。
        """
        if not self._bootstrapped:
            self.bootstrap()
        payload = {
            "key": aes_encrypt(self.session_key),
            "organization_id": aes_encrypt(ORG_ID),
            "openId": aes_encrypt(open_id),
        }
        return self.s.post(API + "/weChat-auth", data=payload, timeout=self.timeout)

    def exchange_wechat(self, open_id: str, tries: int = 3) -> dict:
        """openId → access_token，带校验与退避重试。

        之前的实现在 `status_code == 200` 时就当成成功，但平台换票失败同样回 200
        （body 里是 errorCode），于是扫码后「看着换了票、其实没有凭证」。
        这里以 **body 里真的有 access_token** 作为唯一成功判据。
        """
        last: dict = {"ok": False, "reason": "no_attempt"}
        for i in range(1, tries + 1):
            try:
                resp = self.wechat_auth(open_id)
            except requests.RequestException as exc:
                last = {"ok": False, "reason": "network", "error": str(exc)[:160], "tries": i}
                time.sleep(0.4 * i)
                continue
            try:
                body = resp.json()
            except ValueError:
                body = {"raw": resp.text[:300]}
            if resp.status_code == 200 and isinstance(body, dict) and body.get("access_token"):
                return {"ok": True, "token": body, "tries": i}
            last = {"ok": False, "reason": "rejected", "http_status": resp.status_code,
                    "body": body, "tries": i}
            # 90144 = 该微信未绑定平台账号，重试多少次都一样，直接给可执行的提示
            if str((body or {}).get("errorCode")) == "90144":
                last["hint"] = "该微信号尚未绑定平台账号：先在网页端「微信绑定」后再扫码"
                break
            time.sleep(0.4 * i)
        return last

    def wait_any(self, seconds: int = 120, interval: float = 1.0,
                 on_poll=None) -> dict:
        """交替轮询微信 / APP 两条通道，**任一扫到就立刻换票**并返回。

        盘口（实测）：微信未扫 `{}`、已扫 `{"code":"0000","openId":…,"status":true}`、
        失效 `{"code":"0002"}`（极少出现）；APP 未扫 `{}`、已扫直接返回含
        access_token 的授权信息、无过期信号。因此 APP 侧只有拿到 access_token 才算成功。

        返回 {"ok": True, "channel": ..., "token": {...},
              "scanned_after": 秒, "exchange_ms": 毫秒}
        或   {"ok": False, "timeout": True, "elapsed": 秒, "events": [...]}
        """
        t0 = time.time()
        deadline = t0 + seconds
        events: list[dict] = []
        while time.time() < deadline:
            # ---- 通道一：微信 ----
            if self.wechat_uuid:
                try:
                    d = self.probe_wechat()
                except requests.RequestException as exc:
                    d = {"_err": str(exc)[:120]}
                if on_poll:
                    on_poll("wechat", d)
                if d.get("code") == "0002":
                    events.append({"ch": "wechat", "event": "expired"})
                    self.wechat_uuid = None          # 本轮不再查，等调用方换码
                elif d.get("status") and d.get("openId") and d["openId"] not in self._dead_openids:
                    # 已确认换不了票的 openId 直接跳过（不再打换票接口），但仍会降到下面等 APP
                    oid = d["openId"]
                    scanned = round(time.time() - t0, 1)
                    mark = time.time()
                    ex = self.exchange_wechat(oid)
                    ms = round((time.time() - mark) * 1000)
                    events.append({"ch": "wechat", "event": "scanned", "at": scanned,
                                   "exchange_ms": ms, "ok": ex.get("ok"),
                                   "detail": None if ex.get("ok") else ex})
                    if ex.get("ok"):
                        return {"ok": True, "channel": "wechat", "token": ex["token"],
                                "scanned_after": scanned, "exchange_ms": ms,
                                "tries": ex.get("tries"), "events": events}
                    # 换票被业务性拒绝：这条通道本轮没有重试价值，交回 APP 通道
                    if ex.get("reason") == "rejected":
                        self._dead_openids.add(oid)
                        self.wechat_uuid = None

            # ---- 通道二：APP ----
            if self.uuid:
                try:
                    d = self.probe_app()
                except requests.RequestException as exc:
                    d = {"_err": str(exc)[:120]}
                if on_poll:
                    on_poll("app", d)
                if isinstance(d, dict) and d.get("access_token"):
                    scanned = round(time.time() - t0, 1)
                    events.append({"ch": "app", "event": "scanned", "at": scanned})
                    return {"ok": True, "channel": "app", "token": d,
                            "scanned_after": scanned, "exchange_ms": 0, "events": events}

            time.sleep(interval)

        return {"ok": False, "timeout": True, "elapsed": round(time.time() - t0, 1),
                "events": events}

    # ---------------------- 等待登录（过期自动重取） ---------------------- #
    def wait_login(self, kind: str = "wechat", ttl: int = 60, max_cycles: int = 3,
                   interval: float = 2.0, on_qr=None, save_dir: str | None = None,
                   on_poll=None) -> dict:
        """取码 → 轮询 → 未登录且过期则重新取码，直到扫码成功或循环用尽。

        两条通道的「过期」判定不同：
          - 微信：服务端返回 {"code":"0002"}，立即重取；
          - APP ：服务端永不报过期，只能按 ttl 计时到点重取。

        on_qr(kind, uuid, png, cycle) 用于把每一轮的二维码交给调用方展示。
        返回 {"ok":bool, "token":..., "events":[...]}，events 记录每一轮的起止与原因。
        """
        events: list[dict] = []
        for cycle in range(1, max_cycles + 1):
            if kind == "wechat":
                out = f"{save_dir}/qr-wechat-{cycle}.png" if save_dir else None
                _url, png = self.create_wechat_qr(out)
                uid = self.wechat_uuid
            else:
                out = f"{save_dir}/qr-app-{cycle}.png" if save_dir else None
                png = self.fetch_app_qr(out)
                uid = self.uuid

            ev = {"cycle": cycle, "kind": kind, "uuid": uid,
                  "issued_at": time.strftime("%H:%M:%S"), "file": out}
            events.append(ev)
            if on_qr:
                on_qr(kind, uid, png, cycle)

            t0 = time.time()
            reason = "ttl" if kind == "app" else "poll_ttl"
            token = None
            while time.time() - t0 < ttl:
                try:
                    data = self.probe_wechat() if kind == "wechat" else self.probe_app()
                except requests.RequestException as exc:   # 抖动不该让整轮白跑
                    data = {"_err": str(exc)[:120]}
                if on_poll:
                    on_poll(cycle, data)

                if kind == "wechat":
                    if data.get("code") == "0002":
                        reason = "server_expired"
                        break
                    if data.get("status") and data.get("openId"):
                        ev["scanned_after"] = round(time.time() - t0, 1)
                        # 与 wait_any 同一判据：换票拿到 access_token 才算登录成功
                        ex = self.exchange_wechat(data["openId"])
                        reason = "scanned" if ex.get("ok") else "exchange_failed"
                        ev["exchange"] = None if ex.get("ok") else ex
                        token = ex.get("token") if ex.get("ok") else None
                        break
                else:
                    # APP 通道未扫是 {}，且服务端可能把错误文本当 200 返回（raw）
                    if isinstance(data, dict) and data.get("access_token"):
                        ev["scanned_after"] = round(time.time() - t0, 1)
                        token = data
                        reason = "scanned"
                        break

                time.sleep(interval)

            ev["ended"] = reason
            ev["elapsed"] = round(time.time() - t0, 1)
            if token is not None:
                return {"ok": True, "kind": kind, "token": token, "events": events}

        return {"ok": False, "kind": kind, "timeout": True, "events": events}

    # -------------------- 方式三：账密登录（APP 通道）-------------------- #
    def app_login(self, username: str, password: str, *,
                  company_name: str = APP_LOGIN_COMPANY,
                  login_method: str = "login-by-user",
                  client_id: int = 999,
                  terminal: str = APP_LOGIN_TERMINAL,
                  system: str = APP_LOGIN_SYSTEM,
                  display_dynamic: bool = True,
                  timeout: int | None = None) -> dict:
        """账密登录，走 APP 端接口，**不需要会话 key，也不需要验证码**。

        与网页端 `/auth` 的三点差异（这也是它作为首选的三个理由）：
          1. 无 key 依赖：不用先打开登录页抓 hashKey，纯无状态请求；
          2. 无验证码：`doubleValidate=1` 的组织用 `/auth` 必须人工补 6 位码，
             本接口的 `captcha` 始终留空即可通过；
          3. 长效：返回 expires_in=2592000（30 天），网页端只有 4 小时。

        协议要点（缺一不可）：
          - Content-Type 必须是 application/x-www-form-urlencoded（传 dict 给 requests 即可），
            改发 JSON 会直接 422 / errorCode 900000；
          - body 中**每一个字段值**单独做 AES-128-ECB(PKCS7) -> Base64，不是整体加密；
          - 空字符串原样传（`captcha` 为空时不加密）；
          - 必填五项：username / pword / login_method / company_name / client_id。

        返回平台原始 JSON（含 access_token / expires_in / userid / loginToken）。
        凭据错误抛 LoginError（平台用 422 承载业务错误，不能按 HTTP 状态判断）。
        """
        body = {
            "username": aes_encrypt(username),
            "pword": aes_encrypt(password),
            "company_name": aes_encrypt(company_name),
            "login_method": aes_encrypt(LOGIN_METHODS.get(login_method, login_method)),
            "client_id": aes_encrypt(client_id),
            # 前端 encrypt 对布尔值走 JS 语义，产出小写 "true"/"false"，不能用 str(True)
            "displayDynamic": aes_encrypt("true" if display_dynamic else "false"),
            "terminal": aes_encrypt(terminal),
            "system": aes_encrypt(system),
            "captcha": "",
        }
        # 独立会话：不复用扫码用的 Cookie，尽量贴近 APP 客户端视角。
        # 不要手写 Content-Type：交给 requests 生成标准的 form-urlencoded，
        # 与实测可用的 APP 请求保持一致（多加 charset 等参数可能被严格校验拒绝）。
        s = requests.Session()
        s.trust_env = False
        r = s.post(API + "/app-login", data=body,
                   timeout=timeout or self.timeout, headers={
                       "Accept": "application/json;charset=UTF-8",
                       "X-Requested-With": "XMLHttpRequest",
                       "User-Agent": ("Mozilla/5.0 (Linux; Android 15; BSN-AN00) Mobile"),
                       "Origin": BASE,
                       "Referer": BASE + "/oauth/",
                   })
        # 注意：平台 422 响应**不带 Content-Type**，不能按 content-type 判断，只能直接解析
        try:
            data = r.json()
        except ValueError:
            raise LoginError("", f"非 JSON 响应 HTTP {r.status_code}", r.status_code,
                             {"raw": redact_text(r.text[:300])}) from None
        if not data.get("access_token"):
            raise LoginError(data.get("errorCode", ""), data.get("message", ""),
                             r.status_code, data)
        return data

    # ---------------------------- 表单登录 ----------------------------- #
    def login(self, username: str, password: str, captcha: str = "") -> requests.Response:
        """账号密码登录。doubleValidate=1 时服务端会要求验证码。"""
        self._warmup()
        if not self.session_key:
            raise RuntimeError("缺少会话 key")
        payload = {
            "key": self.session_key,
            "organization_id": aes_encrypt(ORG_ID),
            "login_method": aes_encrypt("account"),
            "username": aes_encrypt(username),
            "pword": aes_encrypt(password),
            "captcha": captcha,
        }
        return self.s.post(API + "/auth", data=payload, timeout=self.timeout)

    def request_captcha(self, channel: str = "mobile", username: str = "") -> requests.Response:
        """请求双因子验证码（channel: mobile 短信 / weChat 微信推送）。"""
        self._warmup()
        payload = {"key": self.session_key, "organization_id": aes_encrypt(ORG_ID),
                   "login_method": aes_encrypt("account"),
                   "username": aes_encrypt(username), "type": aes_encrypt(channel)}
        return self.s.post(API + "/verification-code", data=payload, timeout=self.timeout)

    # ---------------------------- 会话提取 ----------------------------- #
    @staticmethod
    def extract_token(redirect_fragment: str) -> dict:
        """从登录成功后的 redirect_uri#access_token=... 提取令牌。"""
        frag = redirect_fragment.split("#", 1)[-1]
        out = {}
        for kv in frag.split("&"):
            if "=" in kv:
                k, v = kv.split("=", 1)
                out[k] = v
        return out

    def authed_session(self, access_token: str) -> requests.Session:
        """用 access_token 构造业务 API 会话。

        平台自定义格式：Authorization: Bearer__<token>（双下划线）。
        写成标准 "Bearer <token>" 会返回 401 Access is Denied。
        """
        s = requests.Session()
        s.headers.update({"User-Agent": USER_AGENT,
                          "Authorization": f"Bearer__{access_token}",
                          "X-Requested-With": "XMLHttpRequest",
                          "Referer": BASE + "/"})
        return s


def default_qr_out(kind: str) -> str:
    """默认输出位置：数据目录（与 .gitignore 的 qr-*.png 对齐，不污染仓库根）。"""
    return str(_data_dir() / f"qr-{kind}.png")


def fetch_display_name(token_obj) -> str | None:
    """用登录响应里的 access_token 读一次用户信息，返回「姓名（单位）」或 None。

    非致命：取不到只影响展示，不影响 token 本身已经有效这一事实。
    """
    if not isinstance(token_obj, dict):
        return None
    tok = token_obj.get("access_token")
    if not tok:
        return None
    try:
        s = requests.Session()
        s.headers.update({"User-Agent": USER_AGENT,
                          "Authorization": f"Bearer__{tok}",
                          "X-Requested-With": "XMLHttpRequest",
                          "Referer": BASE + "/"})
        j = s.get(BASE + "/api/v1/human/member/center", timeout=10).json()
    except Exception:
        return None
    name, org = j.get("fullName"), j.get("organizationName") or j.get("orgName")
    if name and org:
        return f"{name}（{org}）"
    return name or None


def persist_login(result: dict) -> dict:
    """把扫码换到的 token 落到本地会话（DPAPI 加密），返回落盘信息。"""
    saved, err = None, None
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from mooc_tasks import save_token_from_login   # 延迟导入：避免循环依赖
        saved = save_token_from_login(result.get("token"),
                                      source=f"qr-{result.get('channel') or 'wechat'}")
    except Exception as exc:                            # 落盘失败不该吞掉登录结果
        err = f"{type(exc).__name__}: {exc}"[:160]
    return {"saved": bool(saved), "session": saved, "save_error": err}


def _data_dir() -> Path:
    return Path(os.environ.get("TOBACCO_HOME") or (SKILL_ROOT / "data"))


QR_TITLES = {
    "wechat": ("微信扫码登录", "打开微信「扫一扫」对准二维码；也可先存图再用微信「相册」识别"),
    "app": ("学院 APP 扫码登录", "打开手机端「中国烟草网络学院」APP → 我的 → 扫一扫"),
}


def qr_login_loop(m: "MoocAuth", kinds: list[str], *, seconds: float, ttl: int = 55,
                  interval: float = 1.0, on_qr=None, on_event=None) -> dict:
    """取码 → 等待扫码 → 过期自动换新码，直到登录成功或用完 time。

    同一实例取码与轮询：uuid 与 cookie 会话是绑定的，用"另开一个空 cookie
    的实例取码、再用另一个会话轮询"会永远轮不到（扫码了也没反应）。
    返回 {"ok":True, "channel":.., "token":.., "events":[...]} 或超时结果。
    """
    t0 = time.time()
    deadline = t0 + float(seconds)
    events: list[dict] = []
    issued: dict[str, float] = {}
    cycle = 0
    while True:
        cycle += 1
        for kind in kinds:
            live = issued.get(kind) is not None and time.time() - issued[kind] < ttl
            if kind == "app" and live and m.uuid:
                continue
            if kind == "wechat" and live and m.wechat_uuid:
                continue
            try:
                if kind == "app":
                    png, uid, url = m.fetch_app_qr(), m.uuid, ""
                else:
                    url, png = m.create_wechat_qr()
                    uid = m.wechat_uuid
            except Exception as exc:                 # 网络抖动不该结束整个登录
                events.append({"cycle": cycle, "ch": kind, "event": "issue_failed",
                               "detail": f"{type(exc).__name__}: {exc}"[:160]})
                continue
            issued[kind] = time.time()
            self_dead = getattr(m, "_dead_openids", None)
            if kind == "wechat" and self_dead:
                self_dead.clear()          # 新码新机会：旧 openId 的失败不该连带新码
            events.append({"cycle": cycle, "ch": kind, "event": "issued", "uuid": uid})
            if on_qr:
                on_qr(kind, uid, png, url, cycle)
        if not issued:
            time.sleep(min(3.0, max(0.5, deadline - time.time())))
            if time.time() >= deadline:
                break
            continue
        if time.time() >= deadline:              # --wait 0：只发码，不等
            break
        left = deadline - time.time()
        res = m.wait_any(seconds=max(1.0, min(float(ttl), left)), interval=interval)
        for ev in res.get("events") or []:
            events.append(ev)
            if on_event and ev.get("event") in ("expired", "scanned"):
                on_event(ev)
        if res.get("ok"):
            res["events"] = events
            res["cycle"] = cycle
            return res
        if not m.wechat_uuid:
            issued.pop("wechat", None)
    return {"ok": False, "timeout": True, "elapsed": round(time.time() - t0, 1),
            "events": events}


def publish_qr(kind: str, png: bytes, *, uid: str, url: str, ttl: int,
               png_path: Path, ascii_fallback: bool = False,
               open_browser: bool = False, cycle: int = 1) -> dict:
    """把码落盘 + 生成可交给 show_widget 的 widget HTML，并返回事件信息。"""
    _save(png_path, png)
    title, hint = QR_TITLES.get(kind, ("扫码登录", "用手机扫码"))
    widget = render_qr_widget(png, title=title, hint=hint, ttl=ttl, uid=uid or "")
    html_path: Path | None = png_path.with_suffix(".html")
    try:
        html_path.write_text(widget_script(widget), encoding="utf-8")
    except OSError as exc:
        html_path = None                       # Path("") 是 "."，用真值判会到处传一个目录
        hint = f"{hint}（widget 文件写入失败：{exc}）"
    if ascii_fallback and kind == "wechat" and url:
        print(ascii_qr(url), flush=True)
    if open_browser and html_path is not None:
        try:
            import webbrowser
            webbrowser.open(html_path.resolve().as_uri())
        except Exception:
            pass
    return {"event": "qr", "ch": kind, "cycle": cycle, "uuid": uid, "url": url,
            "ttl": ttl, "file": str(png_path),
            "widget_html": str(html_path) if html_path is not None else None,
            "show_widget": {"widget_code_file":
                            str(html_path) if html_path is not None else None,
                            "title": title}}


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="烟草网络学院二维码 / 登录 API 工具")
    sub = p.add_subparsers(dest="action", required=True)

    sp = sub.add_parser("qr", help="扫码登录（默认：发 widget 卡片 + 等待扫码，扫到即落盘）")
    sp.add_argument("kind", nargs="?", default="wechat",
                    choices=["app", "wechat", "both"],
                    help="wechat（默认，兼容性最好）/ app / both")
    sp.add_argument("--out", help="输出路径；both 时自动加后缀")
    sp.add_argument("--channel", help="ds 段，默认按域名推断为 online")
    sp.add_argument("--verify", action="store_true", help="解码回验二维码内容（需 zxing-cpp）")
    sp.add_argument("--wait", type=int, default=240,
                    help="发码后阻塞等待扫码的秒数（默认 240）；0=只发码不轮询（扫了也不会换票）")
    sp.add_argument("--interval", type=float, default=1.0,
                    help="轮询间隔秒（默认 1.0；越小扫码后换票越快）")
    sp.add_argument("--ttl", type=int, default=55, help="单张码的有效期秒数（默认 55，过期自动换）")
    sp.add_argument("--no-widget", dest="widget", action="store_false",
                    help="不生成 widget HTML（只要 PNG）")
    sp.add_argument("--ascii", action="store_true", help="终端直接打印二维码（无 widget 能力时兜底）")
    sp.add_argument("--open", action="store_true", help="用默认浏览器打开二维码页面")

    cd = sub.add_parser("card", help="输出登录卡片 widget（二维码 + 账号 + 下一步说明）")
    cd.add_argument("--account", default="", help="已知账号（手机号），可空")
    cd.add_argument("--hint", default="扫码登录最省事；也可以回复手机号后由我发起账密登录。")
    cd.add_argument("--png", help="自带一张二维码 PNG（可选）")
    cd.add_argument("--out", default="", help="输出 HTML 路径，默认 data/login-card.html")
    cd.add_argument("--open", action="store_true", help="用默认浏览器打开")

    sub.add_parser("config", help="查看登录页配置")

    lg = sub.add_parser("login", help="账号密码登录（网页端 /auth，需要会话 key 与验证码）")
    lg.add_argument("--username", required=True)
    lg.add_argument("--password", required=True)
    lg.add_argument("--captcha", default="")
    lg.add_argument("--session-key", required=True)

    al = sub.add_parser("app-login", help="账密登录（APP 通道，免 key、免验证码、30 天）")
    al.add_argument("--username", required=True)
    al.add_argument("--password-stdin", action="store_true",
                    help="从标准输入读密码（推荐，避免密码进入进程列表与历史）")
    al.add_argument("--password", help="直接传密码，仅用于本机调试")
    al.add_argument("--company", default=APP_LOGIN_COMPANY, help=f"默认 {APP_LOGIN_COMPANY}")
    al.add_argument("--method", default="login-by-user",
                    choices=sorted(LOGIN_METHODS.values()), help="login-by-user 账密 / login-by-mobile")
    al.add_argument("--full", action="store_true", help="输出完整 token（默认打码）")

    p.add_argument("--session-key", dest="session_key",
                   help="会话串（hashKey）；不传则本地随机生成，服务端不校验来源")
    a = p.parse_args(argv)

    m = MoocAuth(session_key=getattr(a, "session_key", None))

    if a.action == "card":
        png = Path(a.png).read_bytes() if a.png else None
        html = render_login_widget(hint=a.hint, account=a.account, ttl=55, png=png)
        out = Path(a.out) if a.out else _data_dir() / "login-card.html"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(widget_script(html), encoding="utf-8")
        print(json.dumps({"ok": True, "widget_html": str(out), "widget_code": html},
                         ensure_ascii=False))
        if a.open:
            import webbrowser
            webbrowser.open(out.resolve().as_uri())
        return 0

    if a.action == "config":
        print(json.dumps(m.bootstrap(), ensure_ascii=False, indent=2))
        return 0

    if a.action == "login":
        r = m.login(a.username, a.password, a.captcha)
        print(r.status_code, redact_text(r.text[:500]))
        return 0

    if a.action == "app-login":
        pwd = a.password
        if pwd is None:
            if a.password_stdin or not sys.stdin.isatty():
                pwd = sys.stdin.readline().rstrip("\r\n")
            else:
                import getpass
                pwd = getpass.getpass("密码：")
        if not pwd:
            print("缺少密码：用 --password-stdin 从标准输入提供。", file=sys.stderr)
            return 2
        try:
            resp = m.app_login(a.username, pwd, company_name=a.company,
                               login_method=a.method)
        except LoginError as exc:
            print(json.dumps({"ok": False, "code": exc.code, "hint": exc.hint,
                              "http_status": exc.http_status,
                              "payload": exc.payload}, ensure_ascii=False, indent=2))
            return 1
        show = dict(resp)
        if not a.full:
            for k in ("access_token", "loginToken"):
                if show.get(k):
                    show[k] = mask_token(show[k])
        name = fetch_display_name(resp)
        print(json.dumps({"ok": True, "login_method": "app-login", "user": name,
                          "token": show}, ensure_ascii=False, indent=2))
        if name:
            print(f"[用户] {name}")
        print("[下一步] mooc_tasks.py login-password 会把 token 直接存成本地会话")
        return 0

    kinds = ["app", "wechat"] if a.kind == "both" else [a.kind]
    ttl = max(15, int(a.ttl))
    data_dir = _data_dir()
    data_dir.mkdir(parents=True, exist_ok=True)
    base_out = Path(a.out) if a.out else None
    if base_out and base_out.parent != Path(""):
        base_out.parent.mkdir(parents=True, exist_ok=True)

    def publish(kind: str, uid: str, png: bytes, url: str, cycle: int) -> None:
        # 文件名带 cycle：每轮换新码时不能让宿主把旧码配到新 uuid
        png_path = base_out or data_dir / f"qr-{kind}-{cycle}.png"
        if base_out and len(kinds) > 1:
            png_path = base_out.with_name(
                f"{base_out.stem}-{kind}-{cycle}{base_out.suffix}")
        info = publish_qr(kind, png, uid=uid, url=url, ttl=ttl, png_path=png_path,
                          ascii_fallback=a.ascii, open_browser=a.open, cycle=cycle)
        if a.verify:
            info["content"] = decode_qr(png)
        if not a.widget:
            info["widget_html"] = info["show_widget"] = None
        # 一行一个 JSON：Agent 可以直接把 widget_html 的内容当 widget_code 传给 show_widget
        print(json.dumps(info, ensure_ascii=False), flush=True)

    def on_event(ev: dict) -> None:
        print(json.dumps({"event": ev.get("event"), "ch": ev.get("ch"),
                          "at": ev.get("at")}, ensure_ascii=False), flush=True)

    res = qr_login_loop(m, kinds, seconds=max(0, a.wait), ttl=ttl,
                        interval=max(0.3, a.interval), on_qr=publish,
                        on_event=on_event)

    if a.wait <= 0:                      # 只发码：给 Agent 自己安排后续轮询
        issued = [e for e in (res.get("events") or []) if e.get("event") == "issued"]
        print(json.dumps({"ok": bool(issued), "issued": issued,
                          "session_key": m.session_key,
                          "next": "这张码没有轮询，扫了也换不到票。要登录请直接跑 "
                                  "`mooc_api.py qr wechat`（默认 240s：先发码、再阻塞等扫）"},
                         ensure_ascii=False, indent=2))
        return 0 if issued else 2

    if not res.get("ok"):
        print(json.dumps({"ok": False, "session_key": m.session_key,
                          "login": res}, ensure_ascii=False, indent=2))
        return 1 if not res.get("timeout") else 3

    persist = persist_login(res)
    tok = res.get("token") or {}
    who = fetch_display_name(tok)
    tok_show = mask_token(tok.get("access_token"))
    print(json.dumps({"ok": True, "channel": res.get("channel"),
                      "scanned_after": res.get("scanned_after"),
                      "exchange_ms": res.get("exchange_ms"),
                      "cycle": res.get("cycle"),
                      "token": tok_show,
                      "expires_in": tok.get("expires_in"),
                      "user": who,
                      "session": persist.get("session"),
                      "save_error": persist.get("save_error"),
                      "events": res.get("events")},
                     ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
