# -*- coding: utf-8 -*-
"""纯逻辑: token 过期 / 文本宽度 / 排序 / 配额熔断。"""
import json
import time

import pytest

import mooc_api_login as m
import mooc_auto_study as st
import mooc_client
from mooc_auto_study import QuotaExhausted
from mooc_tui import SORT_MODES, disp_width, fit_text


# ---------------------------------------------------------------- token 过期

def _tok(**kw):
    base = {"access_token": "x", "expires_in": 2592000, "login_time": time.time()}
    base.update(kw)
    return base


def test_token_expired_none():
    assert mooc_client.token_expired(None)


def test_token_missing_field():
    assert mooc_client.token_expired({"login_time": time.time()})


def test_token_fresh_ok():
    assert not mooc_client.token_expired(_tok())


def test_token_near_expiry():
    tok = _tok(login_time=time.time() - 2592000 + 3600)   # 剩余不足1天
    assert mooc_client.token_expired(tok)


# ---------------------------------------------------------------- 文本宽度

def test_disp_width_cjk_is_two():
    assert disp_width("中文") == 4
    assert disp_width("中文abc") == 7
    assert disp_width("") == 0


def test_fit_text_no_truncate():
    s = "烟草专卖管理师基础知识 第一章"
    assert fit_text(s, 36) == s


def test_fit_text_truncates_with_ellipsis():
    out = fit_text("深入贯彻习近平总书记论述摘编系列课程", 36)
    assert disp_width(out) <= 36
    assert out.endswith("…")


# ---------------------------------------------------------------- 默认排序

def _row(req="必修", state="学习中", push=0, name="x", bid=None):
    return {"type": "课程", "required": req, "state": state, "name": name,
            "bid": bid or name, "runnable": state != "已完成",
            "reg_ts": 0, "push_ts": push}


def test_default_sort_done_last():
    key = SORT_MODES[0][1]
    rows = [_row(state="已完成", name="done"), _row(state="学习中", name="doing")]
    assert sorted(rows, key=key)[0]["name"] == "doing"


def test_default_sort_push_desc_within_undone():
    key = SORT_MODES[0][1]
    rows = [_row(push=100, name="old"), _row(push=200, name="new")]
    assert sorted(rows, key=key)[0]["name"] == "new"


def test_default_sort_required_first_on_tie():
    key = SORT_MODES[0][1]
    rows = [_row(req="选修", push=100, name="opt"), _row(req="必修", push=100, name="must")]
    assert sorted(rows, key=key)[0]["name"] == "must"


# ---------------------------------------------------------------- 配额熔断

def test_quota_stops_todo(tmp_path, monkeypatch):
    """配额满 → run_todo 立即停止, 剩余任务不处理。"""
    bot = st.StudyBot(verbose=False, ws=False, mode="audio")
    calls = []
    bot.list_tasks = lambda: [
        {"name": f"任务{c}", "businessId": c, "businessType": 2, "status": 1,
         "startTime": 0} for c in "ABC"]
    bot.hours_self = lambda: {"hourSelf": 0, "requireCourseHour": 50}

    def fake_run(cid, **kw):
        calls.append(cid)
        if cid == "B":
            raise QuotaExhausted("配额已满")
        return 1, 1
    bot.run_course = fake_run
    bot.run_todo()
    assert calls == ["A", "B"]          # C 未被处理


def test_quota_stops_hours(tmp_path, monkeypatch):
    bot = st.StudyBot(verbose=False, ws=False, mode="audio")
    calls = []
    bot.list_tasks = lambda: [
        {"name": f"任务{c}", "businessId": c, "businessType": 2, "status": 1,
         "startTime": 0} for c in "AB"]
    bot.hours_self = lambda: {"hourSelf": 84.2, "requireCourseHour": 50.0}

    def fake_run(cid, **kw):
        calls.append(cid)
        if cid == "B":
            raise QuotaExhausted("配额已满")
    bot.run_course = fake_run
    bot.run_hours(2)
    assert calls == ["A", "B"]


def test_future_tasks_skipped(tmp_path):
    """startTime 在未来的任务被跳过。"""
    bot = st.StudyBot(verbose=False, ws=False, mode="audio")
    calls = []
    bot.list_tasks = lambda: [
        {"name": "future", "businessId": "F", "businessType": 2, "status": 1,
         "startTime": time.time() * 1000 + 86400000},
        {"name": "now", "businessId": "N", "businessType": 2, "status": 1,
         "startTime": 0}]
    bot.run_course = lambda cid, **kw: (calls.append(cid), (1, 1))[1]
    bot.run_todo()
    assert calls == ["N"]


# ---------------------------------------------------------------- token 解析

def test_load_token_safe(tmp_path, monkeypatch):
    tf = tmp_path / "t.json"
    tf.write_text(json.dumps({"access_token": "abc"}), encoding="utf-8")
    monkeypatch.setattr(m, "token_file", lambda user=None: str(tf))
    from mooc_client import load_token_safe
    assert load_token_safe()["access_token"] == "abc"
