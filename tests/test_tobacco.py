"""tobacco.py 的纯函数：日期解析、紧急度、排期容量与边界。"""
from __future__ import annotations

import datetime as dt

import pytest

import tobacco


def test_parse_date_accepts_common_shapes():
    assert tobacco.parse_date("2026-12-31") == dt.date(2026, 12, 31)
    assert tobacco.parse_date("2026/12/31") == dt.date(2026, 12, 31)
    assert tobacco.parse_date("2026.12.31") == dt.date(2026, 12, 31)
    assert tobacco.parse_date("2026年12月31日") == dt.date(2026, 12, 31)


@pytest.mark.parametrize("raw", [None, "", "  ", "无", "-", "不限", "长期"])
def test_parse_date_returns_none_for_open_ended(raw):
    assert tobacco.parse_date(raw) is None


def test_parse_date_returns_none_for_garbage():
    assert tobacco.parse_date("还有三天") is None
    assert tobacco.parse_date("2026-13-45") is None


def test_urgency_orders_hard_deadlines():
    today = dt.date(2026, 6, 1)
    soon = {"title": "明天截止", "deadline": "2026-06-02", "completed": False,
            "progress": 0, "hours": 2.0}
    later = {"title": "下月截止", "deadline": "2026-07-01", "completed": False,
             "progress": 0, "hours": 2.0}
    assert tobacco.urgency(soon, today) > tobacco.urgency(later, today)


def test_urgency_completed_is_lowest():
    today = dt.date(2026, 6, 1)
    done = {"title": "已完成", "deadline": "2026-06-02", "status": "done",
            "progress": 100, "hours": 2.0}
    todo = {"title": "未完成", "deadline": "2026-12-01", "status": "未开始",
            "progress": 0, "hours": 2.0}
    assert tobacco.urgency(done, today) < tobacco.urgency(todo, today)


def test_remaining_hours_uses_progress():
    t = {"hours": 4.0, "progress": 25, "completed": False}
    assert tobacco.remaining_hours(t) == pytest.approx(3.0)


def test_build_plan_never_exceeds_daily_capacity():
    profile = {"weekday_hours": 1.0, "weekend_hours": 3.0, "work_profile": "office"}
    tasks = [{"id": f"t{i}", "title": f"课{i}", "hours": 6.0, "progress": 0,
              "deadline": "2026-06-30", "kind": "course",
              "credit_group": "网络自学", "status": "未开始"}
             for i in range(3)]
    start = dt.date(2026, 6, 1)          # 周一
    plan = tobacco.build_plan(tasks, 7, daily_hours=2.0, start=start, profile=profile)
    assert plan["days"], "应当排出计划"
    for day in plan["days_plan"]:
        assert day["hours"] <= day["capacity"] + 1e-9, \
            f"{day['date']} 超发 {day['hours']}>{day['capacity']}"


def test_build_plan_respects_skip_dates():
    profile = {"weekday_hours": 2.0, "weekend_hours": 2.0,
               "skip_dates": ["2026-06-02"]}
    tasks = [{"id": "t1", "title": "课", "hours": 4.0, "progress": 0,
              "deadline": "2026-06-10", "kind": "course",
              "credit_group": "网络自学", "status": "未开始"}]
    plan = tobacco.build_plan(tasks, 5, daily_hours=2.0,
                              start=dt.date(2026, 6, 1), profile=profile)
    busy = {d["date"] for d in plan["days_plan"] if d["hours"] > 0}
    assert "2026-06-02" not in busy, "被标记为不学的日子不应排任务"


def test_build_plan_does_not_schedule_past_deadline():
    profile = {"weekday_hours": 8.0, "weekend_hours": 8.0}
    tasks = [{"id": "t1", "title": "急", "hours": 3.0, "progress": 0,
              "deadline": "2026-06-02", "kind": "course",
              "credit_group": "网络自学", "status": "未开始"}]
    plan = tobacco.build_plan(tasks, 10, daily_hours=8.0,
                              start=dt.date(2026, 6, 1), profile=profile)
    used = [d["date"] for d in plan["days_plan"] if d.get("items")]
    assert used and max(used) <= "2026-06-02", f"排到了截止日之后：{used}"


def test_day_capacity_weekend_differs():
    profile = {"weekday_hours": 1.0, "weekend_hours": 3.0}
    assert tobacco.day_capacity(profile, dt.date(2026, 6, 1)) == 1.0     # 周一
    assert tobacco.day_capacity(profile, dt.date(2026, 6, 6)) == 3.0     # 周六


def test_task_id_stable_for_same_input():
    a = tobacco.task_id("同一门课", "2026 必修")
    b = tobacco.task_id("同一门课", "2026 必修")
    c = tobacco.task_id("同一门课", "2026 选修")
    assert a == b and a != c
