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
import sys
import time
import uuid as uuidlib
from pathlib import Path

import requests
from Crypto.Cipher import AES
from Crypto.Util.Padding import pad

BASE = "https://mooc.ctt.cn"
API = BASE + "/oauth/api/v1"
AES_KEY = b"d8cg8gVakEq9Agup"          # 前端 key-config.aeskey；平台改版后需重新抓取
AES_FINGERPRINT = "N8XxZPBkHR4UcAuMtuMC4Q=="   # aes_encrypt("1")，用于自检密钥是否失效
ORG_ID = "1"
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
    """写文件前确保父目录存在。"""
    if not path:
        return
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(data)


def render_qr(text: str, size: int = 160, out: str | Path | None = None) -> bytes:
    """本地渲染二维码（与前端 qrcodejs2 一致：纠错等级 Q）。"""
    try:
        import qrcode
        from qrcode.constants import ERROR_CORRECT_Q
    except ImportError as exc:  # pragma: no cover
        raise SystemExit("缺少依赖：pip install qrcode pillow") from exc

    from PIL import Image

    qr = qrcode.QRCode(error_correction=ERROR_CORRECT_Q, box_size=10, border=2)
    qr.add_data(text)
    qr.make(fit=True)
    img = qr.make_image(fill_color="black", back_color="white").convert("RGB")
    # 最近邻缩放，保持模块边缘锐利（抗锯齿会降低扫码成功率）
    img = img.resize((size, size), Image.NEAREST)
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
        self.session_key = session_key     # 即前端 app.global.hashKey
        self.uuid: str | None = None       # APP 扫码的 uuid（服务端下发）
        self.wechat_uuid: str | None = None
        self.wechat_url: str | None = None

    # ------------------------------------------------------------------ #
    def _warmup(self) -> None:
        if not self.s.cookies:
            self.s.get(BASE + "/oauth/", timeout=self.timeout)

    def bootstrap(self) -> dict:
        """取登录页配置与皮肤。响应可用于确认 weChatLogin/doubleValidate 开关。"""
        self._warmup()
        b64 = base64.b64encode(
            b"response_type=token&client_id=999&redirect_uri=https%3A%2F%2Fmooc.ctt.cn"
            b"&state=%2Fhome&lang=cn&cancelRememberState=0").decode()
        cfg = self.s.get(API + "/setting", params={"key": b64}, timeout=self.timeout).json()
        self.s.get(API + "/skin",
                   params={"organizationId": ORG_ID, "clientType": 1, "language": 1},
                   timeout=self.timeout)
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
        """微信扫码换票（security:true，参数需 AES 加密）。"""
        if not self.session_key:
            raise RuntimeError("weChat-auth 需要会话 key（hashKey）")
        payload = {
            "key": self.session_key,
            "organization_id": aes_encrypt(ORG_ID),
            "openId": aes_encrypt(open_id),
        }
        return self.s.post(API + "/weChat-auth", data=payload, timeout=self.timeout)

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
                data = self.probe_wechat() if kind == "wechat" else self.probe_app()
                if on_poll:
                    on_poll(cycle, data)

                if kind == "wechat":
                    if data.get("code") == "0002":
                        reason = "server_expired"
                        break
                    if data.get("status"):
                        ev["scanned_after"] = round(time.time() - t0, 1)
                        resp = self.wechat_auth(data.get("openId", ""))
                        token = resp.json() if resp.status_code == 200 else {"error": resp.text[:300]}
                        reason = "scanned"
                        break
                else:
                    if data:
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
                             {"raw": r.text[:300]}) from None
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


def _default_out(kind: str) -> str:
    base = os.environ.get("TOBACCO_OUT") or str(Path.cwd())
    return str(Path(base) / f"mooc-{kind}-qr.png")


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="烟草网络学院二维码 / 登录 API 工具")
    sub = p.add_subparsers(dest="action", required=True)

    sp = sub.add_parser("qr", help="生成二维码（app 或 wechat）")
    sp.add_argument("kind", choices=["app", "wechat", "both"])
    sp.add_argument("--out", help="输出路径；both 时自动加后缀")
    sp.add_argument("--channel", help="ds 段，默认按域名推断为 online")
    sp.add_argument("--verify", action="store_true", help="解码回验二维码内容（需 zxing-cpp）")
    sp.add_argument("--wait", type=int, default=0, help="生成后轮询 N 秒等待扫码")

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

    p.add_argument("--session-key", dest="session_key", help="会话串（hashKey）")
    a = p.parse_args(argv)

    m = MoocAuth(session_key=getattr(a, "session_key", None))

    if a.action == "config":
        print(json.dumps(m.bootstrap(), ensure_ascii=False, indent=2))
        return 0

    if a.action == "login":
        r = m.login(a.username, a.password, a.captcha)
        print(r.status_code, r.text[:500])
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
                    show[k] = str(show[k])[:10] + "..."
        name = fetch_display_name(resp)
        print(json.dumps({"ok": True, "login_method": "app-login", "user": name,
                          "token": show}, ensure_ascii=False, indent=2))
        if name:
            print(f"[用户] {name}")
        print("[下一步] mooc_tasks.py login-password 会把 token 直接存成本地会话")
        return 0

    kinds = ["app", "wechat"] if a.kind == "both" else [a.kind]
    result = {}
    for kind in kinds:
        out = a.out or _default_out(kind)
        if len(kinds) > 1 and a.out:
            out = str(Path(a.out).with_name(Path(a.out).stem + f"-{kind}" + Path(a.out).suffix))
        if kind == "app":
            png = m.fetch_app_qr(out)
            content = decode_qr(png) if a.verify else None
            result["app"] = {"file": out, "uuid": m.uuid, "content": content,
                             "bytes": len(png)}
        else:
            url, png = m.create_wechat_qr(out, a.channel)
            content = decode_qr(png) if a.verify else url
            result["wechat"] = {"file": out, "uuid": m.wechat_uuid,
                                "url": url, "content": content, "bytes": len(png)}

    print(json.dumps(result, ensure_ascii=False, indent=2))

    if a.wait:
        if "wechat" in result:
            r = m.poll_wechat_status(max_seconds=a.wait)
        else:
            r = m.poll_app_login(max_seconds=a.wait)
        print(json.dumps({"poll": r}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
