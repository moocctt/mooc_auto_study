# -*- coding: utf-8 -*-
"""resolve_user / resolve_course: --user 解析逻辑。"""
import pytest

import mooc_api_login as m
import mooc_auto_study as st


@pytest.fixture
def two_users(tmp_path, monkeypatch):
    env_file = tmp_path / ".env"
    env_file.write_text(
        "MOOC_LOGIN=138A\nMOOC_PASS=pa\n"
        "MOOC_LOGIN=138B\nMOOC_PASS=pb\n", encoding="utf-8")
    monkeypatch.setattr(m, "ENV_FILE", str(env_file))
    # display_name 模拟: 138A 已登录过, 平台叫 陈学新
    tok = tmp_path / "tok.json"
    tok.write_text(json.dumps({"access_token": "x", "display_name": "陈学新"}),
                   encoding="utf-8")
    monkeypatch.setattr(m, "token_file",
                        lambda user=None: str(tok) if user == "138A"
                        else str(tmp_path / f"tok_{user}.json"))
    return env_file


import json  # noqa: E402


def test_none_returns_default(two_users):
    assert st.resolve_user(None) is None


def test_exact_username(two_users):
    assert st.resolve_user("138A") == "138A"
    assert st.resolve_user("138B") == "138B"


def test_display_name_match(two_users):
    assert st.resolve_user("陈学新") == "138A"


def test_prefix_unique(two_users):
    assert st.resolve_user("陈") == "138A"       # 唯一前缀命中真实姓名


def test_prefix_ambiguous(two_users):
    with pytest.raises(SystemExit):
        st.resolve_user("1")                     # 138A/138B 都命中


def test_missing_account(two_users):
    with pytest.raises(SystemExit):
        st.resolve_user("不存在的账号")
