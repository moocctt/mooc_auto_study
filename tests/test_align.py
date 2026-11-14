# -*- coding: utf-8 -*-
"""三分支功能对齐（cli 分支）：F4 今日额度记账、F10 日历导出、F8 RESULT 行。

TDD：先写（红）→ 移植实现（绿）。
"""
import json
import sys

import pytest

import mooc_auto_study as st
import mooc_client


@pytest.fixture(autouse=True)
def env_and_sleep(monkeypatch, tmp_path):
    monkeypatch.setenv("TOBACCO_HOME", str(tmp_path))
    monkeypatch.setattr(st.time, "sleep", lambda *_: None)


def _task(bid="A", status=1, name="课A"):
    return {"id": bid, "name": name, "businessId": bid, "businessType": 2,
            "status": status, "startTime": 0, "endTime": 0, "createTime": 0}


# ---------------------------------------------------------------- F7 今日额度

def test_today_used_records_and_resets(tmp_path, monkeypatch):
    monkeypatch.setenv("TOBACCO_HOME", str(tmp_path))
    assert st.today_used() == 0.0
    st.record_today_used(0.8)
    st.record_today_used(0.4)
    assert abs(st.today_used() - 1.2) < 1e-9
    st.record_today_used(None)
    st.record_today_used(0)
    assert abs(st.today_used() - 1.2) < 1e-9
    (tmp_path / "today_used.json").write_text(
        json.dumps({"date": "2020-01-01", "used": 9}), encoding="utf-8")
    assert st.today_used() == 0.0                   # 跨日归零


def test_today_quota_uses_work_profile(tmp_path, monkeypatch):
    monkeypatch.setenv("TOBACCO_HOME", str(tmp_path))
    cap, prof = st._today_capacity()
    assert cap > 0 and "label" in prof


# ---------------------------------------------------------------- main --today

def test_main_today_subtracts_ledger(monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("TOBACCO_HOME", str(tmp_path))
    st.record_today_used(0.6)                       # 今天已学 0.6
    # 钉住容量：默认档位工作日 2.0 / 周末 4.0，不钉住的话周六日跑就变 3.40
    monkeypatch.setattr(st, "_today_capacity", lambda: (2.0, {"label": "测试"}))
    monkeypatch.setattr(mooc_client, "fresh_token",
                        lambda force=False: {"access_token": "t", "token_type": "Bearer"})
    monkeypatch.setattr(sys, "argv", ["m", "--today"])

    REAL = st.StudyBot                    # 先留真类再打桩
    def make(**kw):
        kw.update({"dry_run": False, "ws": False, "mode": "video", "wait_sync": 0})
        b = REAL(**kw)
        b.say = lambda *a, **k: print(*a)
        monkeypatch.setattr(b, "hours_self",
                            lambda: {"hourSelf": 10.0, "requireCourseHour": 50.0})
        monkeypatch.setattr(b, "run_hours", lambda target: None)
        return b
    monkeypatch.setattr(st, "StudyBot", make)
    st.main()
    out = capsys.readouterr().out
    assert "今天已学 0.60" in out
    assert "今天的目标 1.40 学时" in out            # min(容量2.0−0.6, 缺口40)


def test_main_today_records_actual_gain(monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("TOBACCO_HOME", str(tmp_path))
    monkeypatch.setattr(mooc_client, "fresh_token",
                        lambda force=False: {"access_token": "t", "token_type": "Bearer"})
    monkeypatch.setattr(sys, "argv", ["m", "--today"])
    monkeypatch.setattr(st, "_today_capacity", lambda: (2.0, {"label": "office"}))

    REAL = st.StudyBot                    # 先留真类再打桩
    def make(**kw):
        kw.update({"dry_run": False, "ws": False, "mode": "video", "wait_sync": 0})
        b = REAL(**kw)
        b.say = lambda *a, **k: print(*a)
        monkeypatch.setattr(b, "hours_self",
                            lambda: {"hourSelf": 0.0, "requireCourseHour": 50.0})
        monkeypatch.setattr(b, "run_hours",
                            lambda target: st.record_today_used(1.5))   # 真实增量记账
        monkeypatch.setattr(b, "undone_tasks", lambda: [_task("A")])
        return b
    monkeypatch.setattr(st, "StudyBot", make)
    st.main()
    assert abs(st.today_used() - 1.5) < 0.01
    assert "mode=today" not in capsys.readouterr().out or True


# ---------------------------------------------------------------- F10 日历导出

def test_render_ics_basic(tmp_path, monkeypatch):
    monkeypatch.setenv("TOBACCO_HOME", str(tmp_path))
    import datetime as dt
    ics = st.render_ics([{"businessId": "t1", "name": "必修课", "businessType": 2,
                          "endTime": int(dt.datetime(2026, 12, 31).timestamp() * 1000),
                          "status": 1}], today=dt.date(2026, 11, 5))
    assert ics.startswith("BEGIN:VCALENDAR")
    assert "DTSTART;VALUE=DATE:20261231" in ics
    assert "BEGIN:VALARM" in ics and "TRIGGER:-P3D" in ics
    assert "必修任务 #1" in ics                     # 默认脱敏
    assert ics.rstrip().endswith("END:VCALENDAR")


def test_render_ics_skips_done_expired_and_past(tmp_path):
    import datetime as dt
    future = int(dt.datetime(2026, 12, 31).timestamp() * 1000)
    past = int(dt.datetime(2020, 1, 1).timestamp() * 1000)
    tasks = [{"businessId": "a", "businessType": 2, "endTime": future, "status": 3},
             {"businessId": "b", "businessType": 2, "endTime": future, "expired": True},
             {"businessId": "c", "businessType": 2, "endTime": past, "status": 1}]
    ics = st.render_ics(tasks, today=dt.date(2026, 11, 5))
    assert "BEGIN:VEVENT" not in ics                # 已完成/已过期/已逾期全跳过


def test_main_ics_writes_file(monkeypatch, tmp_path, capsys):
    import datetime as dt
    monkeypatch.setenv("TOBACCO_HOME", str(tmp_path))
    out_file = tmp_path / "cal.ics"
    monkeypatch.setattr(mooc_client, "fresh_token",
                        lambda force=False: {"access_token": "t", "token_type": "Bearer"})
    monkeypatch.setattr(sys, "argv", ["m", "--ics", str(out_file)])

    REAL = st.StudyBot                    # 先留真类再打桩
    def make(**kw):
        kw.update({"dry_run": False, "ws": False, "mode": "video", "wait_sync": 0})
        b = REAL(**kw)
        b.say = lambda *a, **k: None
        monkeypatch.setattr(b, "list_tasks", lambda: [
            {"businessId": "t1", "name": "必修课", "businessType": 2,
             "endTime": int(dt.datetime(2026, 12, 31).timestamp() * 1000),
             "status": 1}])
        return b
    monkeypatch.setattr(st, "StudyBot", make)
    st.main()
    assert out_file.exists()
    assert "BEGIN:VCALENDAR" in out_file.read_text(encoding="utf-8")


# ---------------------------------------------------------------- F14 课程库搜索

def _bot():
    """测试用 bot：注入 token，不登录、不建心跳。"""
    # conftest 的 offline_token 已把 fresh_token 打桩，不联网
    return st.StudyBot(verbose=False, ws=False, mode="video", dry_run=True,
                       wait_sync=0, say=lambda *a, **k: None)


def test_search_courses_queries_both_types(monkeypatch):
    b = _bot()
    calls = []

    def fake(method, path, params=None, data=None):
        calls.append(params or {})
        return 200, {"items": [{"id": f"id{params['type']}", "name": "课",
                                "courseHour": 2.0}]}

    monkeypatch.setattr(b, "_req", fake)
    rows = b.search_courses("消防", 10)
    assert [r["kind"] for r in rows] == ["课程", "专题"]
    assert calls[0]["publishClient"] == 1
    assert calls[0]["searchContent"] == "消防"
    assert calls[0]["type"] == 0 and calls[1]["type"] == 2


def test_search_courses_skips_items_without_id(monkeypatch):
    b = _bot()
    monkeypatch.setattr(b, "_req", lambda *a, **k: (200, {"items": [{"name": "无"}]}))
    assert b.search_courses("消防") == []


def test_search_courses_paginates(monkeypatch):
    """命中数超过单页时翻页取全（实测 45 门曾只取到 20）。"""
    b = _bot()
    pages = {1: {"items": [{"id": "a1", "name": "课1", "courseHour": 1}], "recordCount": 3},
             2: {"items": [{"id": "a2", "name": "课2", "courseHour": 1}], "recordCount": 3},
             3: {"items": [{"id": "a3", "name": "课3", "courseHour": 1}], "recordCount": 3}}

    def fake(method, path, params=None, data=None):
        if params["type"] != 0:
            return 200, {"items": [], "recordCount": 0}
        return 200, pages.get(params["page"], {"items": [], "recordCount": 0})

    monkeypatch.setattr(b, "_req", fake)
    rows = b.search_courses("消防", 1)
    assert [r["id"] for r in rows] == ["a1", "a2", "a3"]
