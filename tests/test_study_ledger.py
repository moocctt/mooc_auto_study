"""mooc_study.py 的今日额度账本：口径、托底、日期滚动与损坏容错。"""
from __future__ import annotations

import datetime
import json

import pytest

import mooc_study


def _days_ago(n: int) -> str:
    return (mooc_study.cn_today() - datetime.timedelta(days=n)).isoformat()


def test_fresh_ledger_is_zero(home):
    assert mooc_study.today_used() == 0.0


def test_record_hours_sets_base_from_platform(home):
    # 学习前 hourSelf=10，平台当天已记 1 学时 → base=9，所以当天已用就是 1 学时
    mooc_study.record_today_hours(10.0, platform_today=1.0, session_base=10.0)
    obj = json.loads((home / "today_used.json").read_text(encoding="utf-8"))
    assert obj["base"] == 9.0 and obj["last"] == 10.0
    assert mooc_study.today_used(10.0) == 1.0
    # 之后 hourSelf 涨到 10.5：累计已用 = 1.5
    mooc_study.record_today_hours(10.5)
    assert mooc_study.today_used(10.5) == pytest.approx(1.5)


def test_local_extra_protects_against_settlement_lag(home):
    mooc_study.record_today_hours(10.0, platform_today=0.0, session_base=10.0)
    mooc_study.record_today_local(1800)                  # 本地确认上报 0.5h
    assert mooc_study.today_used(10.0) == 0.5, "平台没结算也要算进已用"
    # 平台结算后 hourSelf 涨到 10.6，取 max 不叠加
    mooc_study.record_today_hours(10.6)
    assert mooc_study.today_used(10.6) == pytest.approx(0.6)


def test_base_cannot_be_higher_than_hour_self_minus_extra(home):
    """学习前读数比现在高（重启/结算回退）时，不能让 base 把额度重新给满。"""
    mooc_study.record_today_local(1800)                    # 本地已提交 0.5h
    mooc_study.record_today_hours(10.0, platform_today=0.0,
                                  session_base=12.0)        # 读数反而比现在高 2h
    obj = json.loads((home / "today_used.json").read_text(encoding="utf-8"))
    assert obj["base"] == 9.5, "base 必须夹到 hourSelf - extra"
    assert mooc_study.today_used(10.0) == 0.5


def test_used_never_negative(home):
    mooc_study.record_today_hours(10.0, platform_today=0.0, session_base=10.0)
    mooc_study.record_today_hours(9.0)                   # 平台读数变小时不能出现负数
    assert mooc_study.today_used(9.0) >= 0.0


def test_ledger_rolls_over_new_day(home):
    (home / "today_used.json").write_text(
        json.dumps({"date": _days_ago(1), "base": 1.0, "last": 5.0}), encoding="utf-8")
    assert mooc_study.today_used(5.0) == 0.0


def test_corrupt_ledger_is_treated_as_empty(home):
    (home / "today_used.json").write_text("{ not json", encoding="utf-8")
    assert mooc_study.today_used(5.0) == 0.0
    mooc_study.record_today_hours(5.0, platform_today=0.0, session_base=5.0)
    assert mooc_study.today_used(5.0) == 0.0


def test_today_capacity_falls_back_to_office(home):
    capacity, profile = mooc_study._today_capacity()
    assert capacity > 0
    assert profile.get("work_profile") == "office"


def test_ignore_zero_and_negative_records(home):
    mooc_study.record_today_local(0)
    mooc_study.record_today_local(-5)
    mooc_study.record_today_hours(0)
    assert mooc_study.today_used() == 0.0
