#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""离线假数据 + 真 TUI：在真实终端(tmux)里跑 mooc_tui，供 E2E 键盘测试。

复用 tests/test_tui_full.py 的 FakeBot/ROWS，只换数据不换应用——
compose/渲染/焦点/按键/通知/模态框全部真实，仅后端离线。
用法: python3 tests/fake_tui_app.py   (在 tmux 里跑, 或直接真终端人工体验)
"""
import os
import sys
import tempfile
import time

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _ROOT)
sys.path.insert(0, os.path.join(_ROOT, "tests"))
os.environ.setdefault("TOBACCO_HOME", tempfile.mkdtemp(prefix="tui-e2e-"))

import mooc_api_login
import mooc_tui
from test_tui_full import FakeBot  # noqa: E402


def fake_fresh(force=False):
    return {"access_token": "e2e-token", "token_type": "Bearer",
            "expires_in": 2592000, "login_time": time.time()}


def fake_qr_login_both(ttl=55, cycles=3, on_qr=None, on_error=None):
    """假两路取码：立刻给出 APP/微信两张假 png，然后返回登录成功。"""
    png = b"\x89PNG-fake-e2e"
    for cycle in (1, 2):
        for kind in ("app", "wechat"):
            if on_qr:
                on_qr(kind, cycle, png, "uid-e2e")
        time.sleep(0.5)
    return ("e2e-user", "app")


def fake_add_account(username, password):
    path = os.path.join(os.environ["TOBACCO_HOME"], ".env.e2e")
    with open(path, "a", encoding="utf-8") as f:
        f.write(f"MOOC_LOGIN={username}\nMOOC_PASS=fake\n")
    return path


mooc_tui.StudyBot = FakeBot
mooc_tui.mooc_client.fresh_token = fake_fresh
mooc_tui.env_add_account = fake_add_account
mooc_api_login.qr_login_both = fake_qr_login_both



from mooc_tui import StudyTUI  # noqa: E402

if __name__ == "__main__":
    StudyTUI().run()
