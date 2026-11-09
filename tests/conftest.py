# -*- coding: utf-8 -*-
"""共享夹具: 用临时 .env 隔离测试, 绝不触碰真实账密。"""
import os

import pytest

import mooc_api_login as m


@pytest.fixture
def tmp_env(tmp_path, monkeypatch):
    """临时 .env, 测试结束自动删除。"""
    env_file = tmp_path / ".env"
    env_file.write_text("", encoding="utf-8")
    monkeypatch.setattr(m, "ENV_FILE", str(env_file))
    # 清掉环境变量污染 (此前 _load_dotenv 的 setdefault 可能已注入)
    for k in ("MOOC_USER", "MOOC_PWD"):
        monkeypatch.delenv(k, raising=False)
    return env_file


@pytest.fixture
def base_env(tmp_env):
    tmp_env.write_text("MOOC_USER=u0\nMOOC_PWD=p0\n", encoding="utf-8")
    return tmp_env
