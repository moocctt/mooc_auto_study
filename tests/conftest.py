# -*- coding: utf-8 -*-
"""共享夹具: 用临时 .env 隔离测试, 绝不触碰真实账密。"""
import os

import pytest

import mooc_api_login as m
import mooc_auto_study


@pytest.fixture(autouse=True)
def offline_token(tmp_path, monkeypatch):
    """StudyBot.__init__ 会取 token；单元测试一律打桩，不联网、不碰真凭证。

    同时把 token 目录指到临时目录: 真实登录会在仓库里留下 mooc_token*.json,
    否则 list_accounts() 会把它当成一个账号, 污染账号解析类测试。
    """
    import time

    def fake_fresh(force=False):
        return {"access_token": "test-token", "token_type": "Bearer",
                "expires_in": 2592000, "login_time": time.time()}

    monkeypatch.setattr(m, "_TOKEN_DIR", str(tmp_path))
    monkeypatch.setattr(mooc_auto_study, "fresh_token", fake_fresh)


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
