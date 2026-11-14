"""CLI 冒烟：中文帮助文本在任何输出编码下都不能崩。

Windows 上 `python scripts/x.py --help` 的输出被重定向时，Python 会用 ANSI 代码页
（cp1252），argparse 的中文帮助直接 UnicodeEncodeError —— CI 的 windows 矩阵就是
这么挂的。这里把 PYTHONIOENCODING 强制成 cp1252 钉住这个行为。
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPTS = [
    "tobacco.py",
    "mooc_api.py",
    "mooc_tasks.py",
    "mooc_study.py",
    "mooc_annual.py",
    "mooc_training.py",
    "dual_login.py",
    "flow_test.py",
]
ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.parametrize("name", SCRIPTS)
def test_help_survives_ansi_codepage(name):
    env = dict(os.environ, PYTHONIOENCODING="cp1252", PYTHONUTF8="0")
    r = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / name), "--help"],
        capture_output=True, env=env, timeout=120,
    )
    assert r.returncode == 0, r.stderr.decode("utf-8", "replace")[-800:]
