# -*- coding: utf-8 -*-
"""mooc_api_login: 扫码登录（APP / 微信）+ token 落盘 + 终端字符画。

回归背景:
- 扫码登录曾只存在于 tobacco-mooc-study 的 skill 脚本里，自动学习这边只能用账密
- 两通道的服务端信号都靠不住（未扫永远返回空，过期不报错），只能本地计时换码
"""
import json

import pytest

import mooc_api_login as m


class FakeSession:
    """qr_login 只给 session 赋 trust_env 并交给 _qr_issue/_qr_check。"""

    def __init__(self, *a, **k):
        self.trust_env = True


class FakeResp:
    def __init__(self, payload=None, content=b"1"):
        self._p = payload
        self.content = content

    def json(self):
        return self._p

    def raise_for_status(self):
        pass


@pytest.fixture
def token_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(m, "_TOKEN_DIR", str(tmp_path))
    monkeypatch.delenv("MOOC_HASH_KEY", raising=False)
    return tmp_path


# ---------------------------------------------------------------- 轮询与加密

def test_qr_check_app_variants():
    class S:
        def __init__(self, resp):
            self.resp = resp
            self.calls = []

        def get(self, url, params=None, headers=None, timeout=None):
            self.calls.append((url, params))
            return self.resp

    assert m._qr_check(S(FakeResp(None, b"")), "app", "u", "k") is None
    s = S(FakeResp({}))
    assert m._qr_check(s, "app", "u", "k") is None
    tok = m._qr_check(S(FakeResp({"access_token": "t"})), "app", "u", "k")
    assert tok["access_token"] == "t"

    # 参数必须逐个 AES 加密, key 原样透传
    url, params = s.calls[0]
    assert url == m.APP_CHECK_URL
    assert params["uuid"] == m.enc("u")
    assert params["organizationId"] == m.enc(1)
    assert params["key"] == "k"


def test_session_key_env_override(monkeypatch):
    monkeypatch.delenv("MOOC_HASH_KEY", raising=False)
    assert m._session_key() and m._session_key() != m._session_key()
    monkeypatch.setenv("MOOC_HASH_KEY", "real-hashkey")
    assert m._session_key() == "real-hashkey"


# ---------------------------------------------------------------- 登录主流程

def test_qr_login_app_success(token_dir, monkeypatch):
    monkeypatch.setattr(m, "_qr_issue", lambda s, kind, d=None: ("uuid-1", b"PNG"))
    monkeypatch.setattr(m, "fetch_display_name", lambda tok: "张三")
    replies = [None, {"access_token": "t0k", "token_type": "Bearer",
                      "expires_in": 2592000}]
    monkeypatch.setattr(m, "_qr_check", lambda s, kind, uid, key, on_error=None: replies.pop(0))
    shots = []
    tok, key = m.qr_login("app", session=FakeSession(), interval=0,
                          on_qr=lambda c, png, uid: shots.append((c, png, uid)))

    assert key == "张三"
    assert tok["access_token"] == "t0k"
    assert tok["login_time"] > 0                 # mooc_client 靠它判有效期
    assert shots == [(1, b"PNG", "uuid-1")]      # 每轮都要把新码交出去

    saved = json.loads((token_dir / "mooc_token.张三.json").read_text(encoding="utf-8"))
    assert saved["access_token"] == "t0k"
    assert saved["display_name"] == "张三"
    assert saved["token_type"] == "Bearer"


def test_qr_login_timeout_reissues(token_dir, monkeypatch):
    issued = []

    def issue(s, kind, d=None):
        issued.append(kind)
        return f"uuid-{len(issued)}", b"PNG"

    monkeypatch.setattr(m, "_qr_issue", issue)
    monkeypatch.setattr(m, "_qr_check", lambda s, kind, uid, key, on_error=None: None)
    with pytest.raises(RuntimeError, match="超时"):
        m.qr_login("wechat", session=FakeSession(), ttl=0, cycles=2, interval=0)
    assert issued == ["wechat", "wechat"]        # 过期必须换新码, 不复用


def test_qr_login_bad_kind(token_dir):
    with pytest.raises(ValueError):
        m.qr_login("sms", session=FakeSession())


def test_store_token_explicit_user_wins(token_dir, monkeypatch):
    monkeypatch.setattr(m, "fetch_display_name", lambda tok: None)
    tok, key = m._store_token({"access_token": "a", "userid": "42"}, user="138A")
    assert key == "138A"
    assert json.loads((token_dir / "mooc_token.138A.json").read_text(encoding="utf-8"))["userid"] == "42"


# ---------------------------------------------------------------- 账号列表

def test_qr_only_account_listed(token_dir):
    (token_dir / "mooc_token.138A.json").write_text(json.dumps(
        {"access_token": "x", "display_name": "张三"}), encoding="utf-8")
    accs = {a["key"]: a for a in m.list_accounts()}
    assert accs["138A"]["display_name"] == "张三"
    assert accs["138A"]["qr_only"] is True       # 没有账密, 过期需重扫


# ---------------------------------------------------------------- 终端字符画

def test_qr_ascii_shape():
    pytest.importorskip("qrcode")
    pytest.importorskip("PIL")
    art = m.qr_ascii(m._render_qr("https://example.invalid/login/abc/v5/online"))
    lines = art.split("\n")
    assert set(art) <= set("█▀▄ \n")
    assert len({len(ln) for ln in lines}) == 1   # 每行等宽, 否则终端里会歪
    assert 10 < len(lines) < 40


# ---------------------------------------------------------------- 端归属

def test_token_source_records_app_login(monkeypatch, token_dir):
    """账密登录属于 APP 端会话；token 文件要写明，排查 401 时才知道跟谁互顶。"""
    class R:
        status_code = 200
        headers = {"content-type": "application/json"}
        content = b"1"
        text = ""

        def json(self):
            return {"access_token": "tok", "token_type": "Bearer", "expires_in": 100}

    class S:
        def __init__(self):
            self.trust_env = True

        def post(self, *a, **k):
            return R()

    monkeypatch.setattr(m.requests, "Session", S)     # 不打真接口
    m.login("u", "p", user="demo")
    import os
    saved = json.load(open(os.path.join(str(token_dir), "mooc_token.demo.json"),
                           encoding="utf-8"))
    assert saved["token_source"] == "app-login"
    assert saved["login_time"] > 0


def test_qr_login_marks_side(token_dir, monkeypatch):
    monkeypatch.setattr(m, "_qr_issue", lambda s, kind, d=None: ("u1", b"PNG"))
    monkeypatch.setattr(m, "fetch_display_name", lambda tok: "张三")
    monkeypatch.setattr(m, "_qr_check", lambda *a: {"access_token": "t", "expires_in": 100})
    m.qr_login("wechat", session=FakeSession(), interval=0)
    saved = json.loads((token_dir / "mooc_token.张三.json").read_text(encoding="utf-8"))
    assert saved["token_source"] == "qr-wechat"


def test_describe_source():
    import mooc_client
    assert mooc_client.describe_source({"token_source": "app-login"}) == "APP 端会话"
    assert "网页端" in mooc_client.describe_source({"token_source": "qr-wechat"})
    assert "未知" in mooc_client.describe_source({})
