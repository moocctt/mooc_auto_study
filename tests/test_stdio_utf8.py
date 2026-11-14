# -*- coding: utf-8 -*-
"""CLI 冒烟：中文帮助文本在任意输出编码下都不能崩。

Windows 上 `python mooc_tui.py --help` 的输出被重定向时，Python 会用 ANSI 代码页
（cp1252），argparse 的中文帮助直接 UnicodeEncodeError。这里把 PYTHONIOENCODING
强制成 cp1252 钉住这个行为（修复见 mooc_api_login.utf8_stdio）。
"""
import os
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.parametrize("name", ["mooc_tui.py", "mooc_auto_study.py"])
def test_help_survives_ansi_codepage(name):
    env = dict(os.environ, PYTHONIOENCODING="cp1252", PYTHONUTF8="0")
    r = subprocess.run([sys.executable, str(ROOT / name), "--help"],
                       capture_output=True, env=env, timeout=180)
    assert r.returncode == 0, r.stderr.decode("utf-8", "replace")[-800:]
