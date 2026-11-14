# -*- coding: utf-8 -*-
"""`.env` 支持：工作目录 / $TOBACCO_HOME / 显式路径 / 多账号组 / 不覆盖已有环境变量。"""
import os

import mooc_api_login as m


def _clear(monkeypatch, *keys):
    for k in keys:
        monkeypatch.delenv(k, raising=False)


def test_dotenv_in_cwd(tmp_path, monkeypatch):
    """项目根（当前工作目录）放 .env 就该生效，不必放到 data/ 下。"""
    (tmp_path / ".env").write_text("MOOC_USER=u1\nMOOC_PWD=p1\n", encoding="utf-8")
    monkeypatch.chdir(tmp_path)
    _clear(monkeypatch, "MOOC_USER", "MOOC_PWD")
    assert m._default_account() == ("u1", "p1")


def test_dotenv_from_tobacco_home(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    (home / ".env").write_text("MOOC_USER=uh\nMOOC_PWD=ph\n", encoding="utf-8")
    monkeypatch.setenv("TOBACCO_HOME", str(home))
    monkeypatch.chdir(tmp_path)
    _clear(monkeypatch, "MOOC_USER", "MOOC_PWD")
    assert m._default_account() == ("uh", "ph")


def test_tobacco_env_file_wins(tmp_path, monkeypatch):
    explicit = tmp_path / "custom.env"
    explicit.write_text("MOOC_USER=ux\nMOOC_PWD=px\n", encoding="utf-8")
    (tmp_path / ".env").write_text("MOOC_USER=cwd\n", encoding="utf-8")
    monkeypatch.setenv("TOBACCO_ENV_FILE", str(explicit))
    monkeypatch.chdir(tmp_path)
    _clear(monkeypatch, "MOOC_USER", "MOOC_PWD")
    assert m._default_account()[0] == "ux"


def test_multi_account_groups_from_cwd_env(tmp_path, monkeypatch):
    (tmp_path / ".env").write_text(
        "MOOC_LOGIN=a\nMOOC_PASS=ap\n\nMOOC_LOGIN=b\nMOOC_PASS=bp\n", encoding="utf-8")
    monkeypatch.chdir(tmp_path)
    accs = m._env_envfile_accounts()
    assert [(a["username"], a["password"]) for a in accs] == [("a", "ap"), ("b", "bp")]
    assert [a["key"] for a in accs] == ["a", "b"]


def test_existing_env_var_not_overwritten(tmp_path, monkeypatch):
    (tmp_path / ".env").write_text("MOOC_USER=fromfile\n", encoding="utf-8")
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("MOOC_USER", "fromenv")
    m._load_dotenv()
    assert os.environ["MOOC_USER"] == "fromenv"


def test_env_files_priority_order(tmp_path, monkeypatch):
    home = tmp_path / "h"
    home.mkdir()
    monkeypatch.setenv("TOBACCO_HOME", str(home))
    monkeypatch.chdir(tmp_path)
    paths = m.env_files()
    assert str(home / ".env") in paths
    assert str(tmp_path / ".env") in paths
    assert paths.index(str(home / ".env")) < paths.index(str(tmp_path / ".env"))
