# -*- coding: utf-8 -*-
"""完成态语义回归: 「复习」= finishStatus 2，与 4 同为完成。

证据（2026-11-05，`reverse-analysis` 分支的 `module-study.js`）::

    formatSectionStatus:  t = e.finishStatus
      "1" → icon-bofangqi-zanting1   (学习中)
      "2" → icon-replay_icon         (重播 = 复习)
      "4" → icon-finish              (完成打勾)
    各处完成判定: if (2 !== finishStatus && 4 !== finishStatus) → 未完成

线上现象（本文件的由来）:
  1. 视频看完了，小节仍显示未完成 —— 完成判定只认 2/4 中的一个，或把 2 当"学习中"；
  2. 小节都完成了，专题任务仍显示未完成 —— 任务 status=3 曾被当成"已过期"。
"""
import time

import mooc_auto_study as st
from mooc_tui import _is_done


def _bot():
    """dry-run 的 StudyBot: 不发心跳、不上报, 只跑判定逻辑。"""
    return st.StudyBot(verbose=False, ws=False, dry_run=True, say=lambda *a, **k: None)


def test_done_finish_set_matches_frontend():
    assert st.DONE_FINISH == {2, 4}          # 3 前端不视为完成, 不能算
    assert st.FINISH_NAME[2] == "已完成(复习)"
    assert st.FINISH_NAME[4] == "已完成"
    assert 3 not in st.DONE_FINISH


# ---------------------------------------------------------------- 层级 1: 小节

def test_fake_section_skips_finished_sections(monkeypatch):
    """2(复习) 与 4(完成) 都直接跳过, 连 start-progress 都不发。"""
    bot = _bot()
    started = []
    monkeypatch.setattr(bot, "_start", lambda *a: (started.append(a), (None, None))[1])
    for fin in (2, 4):
        ok, msg = bot.fake_section({"section_id": "s1", "type": 6, "finish": fin,
                                    "name": "x", "resource_id": "r",
                                    "studied": 0, "rate": 100})
        assert ok and "已完成" in msg
    assert started == []


def test_run_course_skips_done_sections(monkeypatch):
    """复习(2)与完成(4) 都不进待处理列表; 新完成的小节算进完成度。"""
    bot = _bot()
    secs = [
        {"section_id": "s1", "type": 6, "finish": 2, "name": "看过的课",
         "resource_id": "r1", "studied": 100, "rate": 100},
        {"section_id": "s2", "type": 6, "finish": 4, "name": "已完成的课",
         "resource_id": "r2", "studied": 100, "rate": 100},
        {"section_id": "s3", "type": 6, "finish": 1, "name": "没看完",
         "resource_id": "r3", "studied": 10, "rate": 10},
    ]
    monkeypatch.setattr(bot, "open_course",
                        lambda cid: ({"name": "专题", "register": True}, secs))
    monkeypatch.setattr(bot, "sections", lambda *a: secs)
    touched = []

    def fake(sec, **kw):
        touched.append(sec["section_id"])
        sec["finish"] = 2               # 刷完回读平台就是复习/完成
        return True, "ok"

    monkeypatch.setattr(bot, "fake_section", fake)
    done, total = bot.run_course("c1")
    assert touched == ["s3"]
    assert (done, total) == (3, 3)


# ---------------------------------------------------------------- 层级 2: 课程/专题

def test_person_courses_state_and_runnable(monkeypatch):
    bot = _bot()
    items = [{"id": c, "courseId": c, "finishStatus": f, "courseInfo": {"name": n}}
             for c, f, n in [("c1", 2, "复习"), ("c2", 4, "完成"),
                             ("c3", 1, "学习中"), ("c4", 0, "未开始")]]
    monkeypatch.setattr(bot, "_req", lambda *a, **kw: (200, {"items": items}))
    monkeypatch.setattr(bot, "list_tasks", lambda: [])

    by = {r["bid"]: r for r in bot.all_view_items()}
    assert by["c1"]["state"] == "已完成(复习)" and by["c1"]["runnable"] is False
    assert by["c2"]["runnable"] is False
    assert by["c3"]["runnable"] is True
    assert by["c4"]["runnable"] is True


def test_settle_nested_accepts_2_and_4(monkeypatch):
    """父小节复核后平台回 2(复习) 或 4 —— 都算完成。"""
    for val in (2, 4):
        bot = _bot()
        monkeypatch.setattr(bot, "_req", lambda *a, **kw: (200, [{"finishStatus": val}]))
        monkeypatch.setattr(bot, "_start", lambda *a: ("log-1", 0))
        monkeypatch.setattr(bot, "_commit_doc", lambda *a: (200, {"finishStatus": val}))
        assert bot.settle_nested("parent", "child", "sec") is True


def test_settle_nested_false_when_regressed(monkeypatch):
    """回读是 0/1 时必须报未完成, 不能把"曾经到过 2"当成功。"""
    bot = _bot()
    monkeypatch.setattr(bot, "_req", lambda *a, **kw: (200, [{"finishStatus": 0}]))
    monkeypatch.setattr(bot, "_start", lambda *a: ("log-1", 0))
    monkeypatch.setattr(bot, "_commit_doc", lambda *a: (200, {"finishStatus": 2}))
    monkeypatch.setattr(st.time, "sleep", lambda *_: None)
    assert bot.settle_nested("parent", "child", "sec", tries=1) is False


# ---------------------------------------------------------------- 层级 3: 任务

def test_task_status_semantics():
    from mooc_tasks import STATUS_NAME
    assert STATUS_NAME == {1: "未完成", 2: "进行中", 3: "已完成"}


def test_undone_tasks_uses_status_only(monkeypatch):
    """任务 status: 1 未开始 / 2 进行中 要学, 3 已完成 不学。"""
    bot = _bot()
    monkeypatch.setattr(bot, "list_tasks", lambda: [
        {"id": 1, "name": "未开始", "businessId": "a", "businessType": 2, "status": 1},
        {"id": 2, "name": "进行中", "businessId": "b", "businessType": 2, "status": 2},
        {"id": 3, "name": "已完成", "businessId": "c", "businessType": 2, "status": 3}])
    assert [t["businessId"] for t in bot.undone_tasks()] == ["a", "b"]


def test_all_view_items_task_status(monkeypatch):
    bot = _bot()
    monkeypatch.setattr(bot, "person_courses", lambda bt: [])
    monkeypatch.setattr(bot, "list_tasks", lambda: [
        {"businessId": "a", "businessType": 3, "status": 3, "name": "学完的", "createTime": 0},
        {"businessId": "b", "businessType": 3, "status": 1, "name": "过期未学",
         "createTime": 0, "expired": True},
        {"businessId": "c", "businessType": 3, "status": 2, "name": "进行中", "createTime": 0},
        {"businessId": "d", "businessType": 3, "status": 1, "name": "没开始", "createTime": 0,
         "startTime": time.time() * 1000 + 86400000}])
    assert {r["bid"]: r["state"] for r in bot.all_view_items()} == {
        "a": "已完成", "b": "已过期", "c": "学习中", "d": "未开始"}


def test_classify_expired_uses_field():
    from mooc_tasks import classify
    items = [{"status": 3, "expired": False, "startTime": 0},
             {"status": 1, "expired": True, "startTime": 0},
             {"status": 2, "expired": False, "startTime": 0}]
    out = classify(items)
    assert len(out["已完成"]) == 1 and len(out["已过期"]) == 1
    assert len(out["未完成"]) == 2


# ---------------------------------------------------------------- TUI 侧

def test_tui_is_done():
    assert _is_done({"state": "已完成(复习)"}) is True
    assert _is_done({"state": "已完成"}) is True
    assert _is_done({"state": "已过期"}) is True
    assert _is_done({"state": "学习中"}) is False
