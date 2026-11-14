"""mooc_tasks.py：会话存取、损坏容错、输出路径护栏。"""
from __future__ import annotations

import json

import pytest

import mooc_tasks


def test_session_roundtrip(home):
    meta = mooc_tasks.save_session("tok-123", 3600, "qr-wechat")
    assert meta["saved"] and meta["source"] == "qr-wechat"
    token, smeta = mooc_tasks.load_session()
    assert token == "tok-123"
    assert smeta["token_source"] == "qr-wechat"


def test_session_file_is_not_plaintext_on_windows(home):
    mooc_tasks.save_session("super-secret-token", 3600, "qr-wechat")
    raw = (home / "session.dat").read_text(encoding="utf-8")
    assert "super-secret-token" not in raw, "token 不能明文落在 session.dat 里"


def test_expired_session_is_rejected(home):
    mooc_tasks.save_session("tok", -10, "qr-wechat")
    with pytest.raises(SystemExit) as exc:
        mooc_tasks.load_session()
    assert "过期" in str(exc.value)


def test_corrupt_session_file_gives_actionable_error(home):
    (home / "session.dat").write_text("{oops", encoding="utf-8")
    with pytest.raises(SystemExit) as exc:
        mooc_tasks.load_session()
    msg = str(exc.value)
    assert "无法解析" in msg and "session --token" in msg


def test_env_token_wins(home, monkeypatch):
    monkeypatch.setenv("MOOC_TOKEN", "env-token")
    token, meta = mooc_tasks.load_session()
    assert token == "env-token" and meta["source"] == "env"


def test_save_token_from_login_ignores_failures(home):
    assert mooc_tasks.save_token_from_login(None) is None
    assert mooc_tasks.save_token_from_login({}) is None
    assert mooc_tasks.save_token_from_login({"errorCode": 90144}) is None
    ok = mooc_tasks.save_token_from_login({"access_token": "abc", "expires_in": 600},
                                          "qr-app")
    assert ok and ok["source"] == "qr-app"


@pytest.mark.parametrize("name", ["tasks.json", "credentials.json", "session.dat"])
def test_safe_out_refuses_skill_data_files(home, name):
    with pytest.raises(SystemExit) as exc:
        mooc_tasks._safe_out(str(home / name))
    assert "拒绝写入" in str(exc.value)


def test_safe_out_rejects_directory(home):
    with pytest.raises(SystemExit) as exc:
        mooc_tasks._safe_out(str(home))
    assert "目录" in str(exc.value)


def test_safe_out_allows_temp_file(tmp_path):
    out = mooc_tasks._safe_out(str(tmp_path / "import.json"))
    assert out.name == "import.json"


class _FakeResp:
    status_code = 401

    def raise_for_status(self):
        pass

    def json(self):
        return {}


class _FakeSession:
    def get(self, *a, **kw):
        return _FakeResp()


def test_get_raises_auth_expired_on_401():
    """401 必须是 AuthExpired（退出码 2），不能是 SystemExit。"""
    with pytest.raises(mooc_tasks.AuthExpired):
        mooc_tasks._get(_FakeSession(), "/human/task")
    assert not issubclass(mooc_tasks.AuthExpired, RuntimeError), "不能继承 RuntimeError"
