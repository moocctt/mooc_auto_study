"""pytest 公共夹具：把 scripts/ 加进导入路径，并把数据目录指到临时目录。

必须在导入 scripts 下的模块之前改 TOBACCO_HOME —— DATA_DIR 是在导入时求值的。
"""
from __future__ import annotations

import atexit
import os
import shutil
import sys
import tempfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))

_TMP_HOME = tempfile.mkdtemp(prefix="tobacco-test-")
atexit.register(shutil.rmtree, _TMP_HOME, True)      # 跑完别在 %TEMP% 里留垃圾
os.environ["TOBACCO_HOME"] = _TMP_HOME
os.environ.pop("MOOC_TOKEN", None)


@pytest.fixture()
def home(tmp_path, monkeypatch):
    """每个用例独立的 TOBACCO_HOME，并让各模块重新读它。"""
    import tobacco

    monkeypatch.setattr(tobacco, "DATA_DIR", tmp_path)
    monkeypatch.setattr(tobacco, "TASKS_FILE", tmp_path / "tasks.json")
    monkeypatch.setattr(tobacco, "CRED_FILE", tmp_path / "credentials.json")
    monkeypatch.setattr(tobacco, "PROFILE_FILE", tmp_path / "profile.json")
    import mooc_tasks

    monkeypatch.setattr(mooc_tasks, "DATA_DIR", tmp_path)
    monkeypatch.setattr(mooc_tasks, "SESSION_FILE", tmp_path / "session.dat")
    import mooc_study

    monkeypatch.setattr(mooc_study, "_today_used_path", lambda: tmp_path / "today_used.json")
    import mooc_training

    monkeypatch.setattr(mooc_training, "CACHE_FILE", tmp_path / "trainings.json")
    return tmp_path
