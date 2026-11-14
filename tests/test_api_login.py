# -*- coding: utf-8 -*-
"""mooc_api_login: 加解密 / 账号解析 / add_account 回归。

回归背景:
- dec() 曾把密文最后字节当 padding 切密文 (应切明文), 从未被发现
- add_account() 原地更新密码时曾丢弃其他账号的 MOOC_PASS 行
"""
import json

import pytest

import mooc_api_login as m
from mooc_api_login import account_credentials, add_account, dec, enc, \
    list_accounts, token_file


# ---------------------------------------------------------------- 加解密

@pytest.mark.parametrize("plain", ["hello", "测试数据123", "13800012345", "a"])
def test_enc_dec_roundtrip(plain):
    assert dec(enc(plain)) == plain


def test_enc_empty_and_none():
    assert enc("") == ""
    assert enc(None) is None


def test_enc_deterministic():
    assert enc("hello") == enc("hello")


# ---------------------------------------------------------------- 多账号解析

def test_two_line_groups(tmp_env):
    tmp_env.write_text(
        "MOOC_USER=u0\nMOOC_PWD=p0\n"
        "\nMOOC_LOGIN=138A\nMOOC_PASS=pa\n"
        "\n# 注释行\nMOOC_LOGIN=138B\nMOOC_PASS=pb\n", encoding="utf-8")
    accs = {a["key"]: a["username"] for a in list_accounts()}
    assert accs == {"138A": "138A", "138B": "138B", "default": "u0"}


def test_credentials_by_username_and_prefix(tmp_env):
    tmp_env.write_text("MOOC_LOGIN=138A\nMOOC_PASS=pa\n", encoding="utf-8")
    assert account_credentials("138A") == ("138A", "pa")
    assert account_credentials("138") == ("138A", "pa")       # 前缀
    assert account_credentials(None) == ("", "")              # 无 default → 空


def test_default_fallback(tmp_env):
    tmp_env.write_text("MOOC_USER=u0\nMOOC_PWD=p0\n", encoding="utf-8")
    assert account_credentials(None) == ("u0", "p0")
    assert account_credentials("default") == ("u0", "p0")


# ---------------------------------------------------------------- add_account

def test_add_appends_two_lines_only(base_env):
    add_account("138A", "pa")
    add_account("138B", "pb")
    content = base_env.read_text(encoding="utf-8")
    assert "MOOC_ACCOUNT=" not in content          # 零命名: 不产生备注行
    assert content.count("MOOC_LOGIN") == 2


def test_add_update_keeps_other_accounts(base_env):
    """回归: 更新 138A 密码时, 138B 的密码行曾被丢弃。"""
    add_account("138A", "pa")
    add_account("138B", "pb")
    add_account("138A", "pa2")
    content = base_env.read_text(encoding="utf-8")
    assert "MOOC_PASS=pa2" in content
    assert "MOOC_PASS=pb" in content               # 其他账号密码不丢
    assert "MOOC_PASS=pa\n" not in content         # 旧密码已覆盖
    assert content.count("MOOC_LOGIN") == 2        # 不产生重复组


def test_add_default_account_untouched(base_env):
    add_account("138A", "pa")
    assert account_credentials(None) == ("u0", "p0")


# ---------------------------------------------------------------- list_accounts

def test_list_accounts_never_exposes_password(base_env):
    add_account("138A", "pa")
    for a in list_accounts():
        assert "password" not in a                 # 对外视图不含密码


def test_token_file_isolation():
    assert token_file(None) != token_file("138A")
    assert token_file("default") == token_file(None)
    import os
    assert os.path.basename(token_file("张三/李四")) == "mooc_token.张三_李四.json"


def test_token_dir_is_not_the_script_dir():
    """token 不能写在仓库根：那里一次 git add -A 就把 access_token 提交上去了。"""
    import os
    assert os.path.abspath(m._TOKEN_DIR) != os.path.dirname(os.path.abspath(m.__file__))


def test_write_token_creates_its_directory(tmp_path):
    target = tmp_path / "deep" / "tokens" / "mooc_token.json"
    m._write_token({"access_token": "t"}, str(target))
    assert target.exists()


def test_legacy_token_in_script_dir_is_migrated(monkeypatch, tmp_path):
    legacy, new = tmp_path / "repo", tmp_path / "data" / "tokens"
    legacy.mkdir()
    (legacy / "mooc_token.json").write_text('{"access_token": "old"}', encoding="utf-8")
    monkeypatch.setattr(m, "_SCRIPT_DIR", str(legacy))
    monkeypatch.setattr(m, "_TOKEN_DIR", str(new))
    m._migrate_legacy_tokens()
    assert (new / "mooc_token.json").read_text(encoding="utf-8") == '{"access_token": "old"}'
    assert not (legacy / "mooc_token.json").exists()
