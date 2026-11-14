# -*- coding: utf-8 -*-
"""mooc_api_login 覆盖补齐：扫码通道、渲染、账号增改、登录失败路径、CLI。"""
import base64
import json

import pytest

import mooc_api_login as m


class Resp:
    def __init__(self, status=200, payload=None, ct="application/json", content=b"1"):
        self.status_code = status
        self._p = payload
        self.headers = {"content-type": ct}
        self.content = content
        self.text = "raw"

    def json(self):
        return self._p

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


class Sess:
    def __init__(self, get=None, post=None):
        self._get = list(get or [])
        self._post = list(post or [])
        self.trust_env = True

    def get(self, *a, **k):
        return self._get.pop(0)

    def post(self, *a, **k):
        return self._post.pop(0)


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setattr(m, "_TOKEN_DIR", str(tmp_path))
    monkeypatch.setattr(m, "ENV_FILE", str(tmp_path / ".env"))
    for k in ("MOOC_USER", "MOOC_PWD", "MOOC_HASH_KEY"):
        monkeypatch.delenv(k, raising=False)
    return tmp_path


# ---------------------------------------------------------------- 扫码通道

def test_qr_issue_app(env):
    png = base64.b64encode(b"PNG").decode()
    s = Sess(get=[Resp(200, {"uuid": "u1", "data": png})])
    uid, got = m._qr_issue(s, "app")
    assert uid == "u1" and got == b"PNG"


def test_qr_issue_wechat_uses_server_uuid(env, monkeypatch):
    monkeypatch.setattr(m, "_render_qr", lambda text, size=160: b"PNG")
    s = Sess(post=[Resp(200, {"uuid": "srv-uuid"})])
    uid, png = m._qr_issue(s, "wechat")
    assert uid == "srv-uuid" and png == b"PNG"


def test_qr_check_wechat_paths(env):
    # 未扫码（status 缺失）→ None
    s = Sess(post=[Resp(200, {"code": "0002"})])
    assert m._qr_check(s, "wechat", "u1", "k") is None
    # 已扫码 → 换票
    s = Sess(post=[Resp(200, {"status": True, "openId": "open"}),
                   Resp(200, {"access_token": "tok"})])
    assert m._qr_check(s, "wechat", "u1", "k")["access_token"] == "tok"
    # 换票失败 → None
    s = Sess(post=[Resp(200, {"status": True, "openId": "open"}),
                   Resp(200, {"errorCode": 1})])
    import pytest
    with pytest.raises(m.QRLoginError):      # 已扫码但换票失败 → 明确报错，不再静默
        m._qr_check(s, "wechat", "u1", "k")


def test_qr_check_app_empty_content(env):
    s = Sess(get=[Resp(200, None, content=b"")])
    assert m._qr_check(s, "app", "u1", "k") is None


# ---------------------------------------------------------------- 渲染与姓名

def test_render_qr_png(env):
    png = m._render_qr("https://example.invalid/x")
    assert png.startswith(b"\x89PNG")


def test_qr_ascii_requires_pillow(env, monkeypatch):
    import builtins
    real = builtins.__import__

    def fake(name, *a, **k):
        if name == "PIL" or name.startswith("PIL."):
            raise ImportError("no pillow")
        return real(name, *a, **k)
    monkeypatch.setattr(builtins, "__import__", fake)
    with pytest.raises(SystemExit, match="pillow"):
        m.qr_ascii(b"x")


def test_fetch_display_name_ok_and_error(monkeypatch):
    class S:
        def __init__(self):
            self.trust_env = True

        def get(self, *a, **k):
            return Resp(200, {"fullName": "张三"})
    monkeypatch.setattr(m.requests, "Session", S)
    assert m.fetch_display_name({"access_token": "t"}) == "张三"

    class Bad:
        def __init__(self):
            self.trust_env = True

        def get(self, *a, **k):
            raise RuntimeError("boom")
    monkeypatch.setattr(m.requests, "Session", Bad)
    assert m.fetch_display_name({"access_token": "t"}) is None


def test_auth_headers(env):
    m._write_token({"access_token": "tok"}, m.token_file(None), "app-login")
    assert m.auth_headers()["Authorization"] == "Bearer tok"


# ---------------------------------------------------------------- 账号增改

def test_read_token_missing_and_broken(env):
    assert m._read_token("nobody") is None
    (env / "mooc_token.bad.json").write_text("{oops", encoding="utf-8")
    assert m._read_token("bad") is None


def test_all_accounts_skips_broken_token(env, monkeypatch):
    monkeypatch.setattr(m, "_read_token", lambda key: (_ for _ in ()).throw(RuntimeError("x")))
    (env / ".env").write_text("MOOC_LOGIN=u1\nMOOC_PASS=p1\n", encoding="utf-8")
    assert [a["key"] for a in m._all_accounts()] == ["u1"]


def test_token_only_accounts_handles_listdir_error(env, monkeypatch):
    monkeypatch.setattr(m.os, "listdir", lambda p: (_ for _ in ()).throw(OSError("nope")))
    assert m._token_only_accounts(set()) == []


def test_token_only_accounts_skips_broken_and_incomplete(env):
    (env / "mooc_token.a.json").write_text("{bad", encoding="utf-8")
    (env / "mooc_token.b.json").write_text(json.dumps({"display_name": "无 token"}),
                                           encoding="utf-8")
    assert m._token_only_accounts(set()) == []


def test_add_account_append_then_update(env):
    p1 = m.add_account("u1", "p1")
    m.add_account("u2", "p2")
    text = (env / ".env").read_text(encoding="utf-8")
    assert "MOOC_LOGIN=u1" in text and "MOOC_LOGIN=u2" in text
    # 原地改密码：其他账号的行必须保留
    m.add_account("u1", "newp")
    text = (env / ".env").read_text(encoding="utf-8")
    assert "MOOC_PASS=newp" in text and "MOOC_LOGIN=u2" in text and "MOOC_PASS=p2" in text
    assert p1.endswith(".env")


def test_add_account_keeps_other_lines(env):
    (env / ".env").write_text("# 注释\nMOOC_USER=du\nMOOC_PWD=dp\n", encoding="utf-8")
    m.add_account("u9", "p9")
    text = (env / ".env").read_text(encoding="utf-8")
    assert "# 注释" in text and "MOOC_LOGIN=u9" in text


# ---------------------------------------------------------------- 登录失败路径

def test_login_rejects_non_json(monkeypatch, env):
    class S:
        def __init__(self):
            self.trust_env = True

        def post(self, *a, **k):
            return Resp(200, None, ct="text/html")
    monkeypatch.setattr(m.requests, "Session", S)
    with pytest.raises(RuntimeError, match="非JSON响应"):
        m.login("u", "p")


def test_login_rejects_missing_token(monkeypatch, env):
    class S:
        def __init__(self):
            self.trust_env = True

        def post(self, *a, **k):
            return Resp(422, {"errorCode": 90908})
    monkeypatch.setattr(m.requests, "Session", S)
    with pytest.raises(RuntimeError, match="登录失败"):
        m.login("u", "p")


# ---------------------------------------------------------------- 剩余分支

def test_list_accounts_skips_empty_username(env):
    (env / ".env").write_text("MOOC_LOGIN=\nMOOC_PASS=p\n", encoding="utf-8")
    assert m.list_accounts() == []


def test_add_account_update_middle_block(env):
    """三块账号，改中间那块：前后块的行都要保留。"""
    (env / ".env").write_text(
        "MOOC_LOGIN=u1\nMOOC_PASS=p1\nMOOC_LOGIN=u2\nMOOC_PASS=p2\n"
        "MOOC_LOGIN=u3\nMOOC_PASS=p3\n", encoding="utf-8")
    m.add_account("u2", "newp2")
    text = (env / ".env").read_text(encoding="utf-8")
    assert "MOOC_PASS=newp2" in text
    assert "MOOC_LOGIN=u1" in text and "MOOC_LOGIN=u3" in text


def test_add_account_update_last_block(env):
    (env / ".env").write_text("MOOC_LOGIN=u1\nMOOC_PASS=p1\n", encoding="utf-8")
    m.add_account("u1", "p1b")
    assert "MOOC_PASS=p1b" in (env / ".env").read_text(encoding="utf-8")


def test_add_account_appends_newline_when_missing(env):
    (env / ".env").write_text("MOOC_LOGIN=u1\nMOOC_PASS=p1", encoding="utf-8")   # 无结尾换行
    m.add_account("u2", "p2")
    text = (env / ".env").read_text(encoding="utf-8")
    assert text.endswith("\n") and "MOOC_LOGIN=u2" in text


def test_render_qr_requires_dependencies(env, monkeypatch):
    import builtins
    real = builtins.__import__

    def fake(name, *a, **k):
        if name == "qrcode" or name.startswith("qrcode."):
            raise ImportError("no qrcode")
        return real(name, *a, **k)
    monkeypatch.setattr(builtins, "__import__", fake)
    with pytest.raises(SystemExit, match="qrcode"):
        m._render_qr("x")


def test_login_fills_credentials_from_env(env, monkeypatch):
    (env / ".env").write_text("MOOC_USER=u0\nMOOC_PWD=p0\n", encoding="utf-8")
    seen = {}

    class S:
        def __init__(self):
            self.trust_env = True

        def post(self, *a, **k):
            seen["data"] = k.get("data")
            return Resp(200, {"access_token": "tok", "token_type": "Bearer"})
    monkeypatch.setattr(m.requests, "Session", S)
    tok = m.login()                       # username/password 都从 .env 取
    assert tok["access_token"] == "tok"
    assert m.dec(seen["data"]["username"]) == "u0"


def test_add_account_handles_login_without_password(env):
    """异常但真实的 .env：连续两行 MOOC_LOGIN / 末尾只有 MOOC_LOGIN。"""
    (env / ".env").write_text("MOOC_LOGIN=u1\nMOOC_LOGIN=u2\nMOOC_PASS=p2\n",
                              encoding="utf-8")
    m.add_account("u1", "p1")            # u1 没有密码行 → 触发行缓冲分支
    text = (env / ".env").read_text(encoding="utf-8")
    assert "MOOC_LOGIN=u1" in text and "MOOC_LOGIN=u2" in text

    (env / ".env").write_text("MOOC_LOGIN=u3\nMOOC_PASS=p3\nMOOC_LOGIN=u4\n",
                              encoding="utf-8")
    m.add_account("u3", "p3b")           # 末尾残留 MOOC_LOGIN=u4 → 触达尾部补写
    assert "MOOC_PASS=p3b" in (env / ".env").read_text(encoding="utf-8")
