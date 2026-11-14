# -*- coding: utf-8 -*-
"""mooc_auto_study 覆盖补齐（二）：任务级批量、学时目标、目标解析、视图与 CLI。"""
import pytest

import mooc_auto_study as st


def _bot(**kw):
    kw.setdefault("dry_run", True)
    kw.setdefault("wait_sync", 0)      # 收尾轮询会忙等 1200s，测试里关掉
    return st.StudyBot(verbose=False, ws=False, say=lambda *a, **k: None, **kw)


@pytest.fixture(autouse=True)
def no_sleep(monkeypatch):
    monkeypatch.setattr(st.time, "sleep", lambda *_: None)


def _sec(sid="s1", fin=1):
    return {"section_id": sid, "type": 6, "finish": fin, "name": "小节 " + sid,
            "resource_id": "r" + sid, "studied": 0, "rate": 0}


def _task(bid="A", status=1, btype=2, name="课A", start=0):
    return {"id": bid, "name": name, "businessId": bid, "businessType": btype,
            "status": status, "startTime": start, "endTime": 0, "createTime": 0}


# ---------------------------------------------------------------- run_course 分支

def test_run_course_sync_only_filters_nested(monkeypatch):
    b = _bot(dry_run=False)
    secs = [dict(_sec("n1"), type=10), dict(_sec("v1"), type=6)]
    monkeypatch.setattr(b, "open_course", lambda cid: ({"name": "课"}, list(secs)))
    monkeypatch.setattr(b, "sections", lambda *a: list(secs))
    monkeypatch.setattr(b, "sync_sections", lambda *a, **k: None)
    ran = []
    monkeypatch.setattr(b, "settle_nested", lambda *a, **k: ran.append(a[2]) or True)
    monkeypatch.setattr(b, "fake_section", lambda *a, **k: pytest.fail("sync 只处理嵌套"))
    monkeypatch.setattr(b, "course_finish", lambda cid: 2)      # 收尾复核不联网
    b.run_course("C1", sync_only=True)
    assert ran == ["n1"]


def test_run_course_catches_section_exception(monkeypatch, capsys):
    b = _bot(dry_run=False)
    monkeypatch.setattr(b, "open_course", lambda cid: ({"name": "课"}, [_sec()]))
    monkeypatch.setattr(b, "sections", lambda *a: [_sec()])
    monkeypatch.setattr(b, "sync_sections", lambda *a, **k: None)

    def boom(*a, **k):
        raise ValueError("坏数据")
    monkeypatch.setattr(b, "fake_section", boom)
    b.say = lambda *a, **k: print(*a)
    done, total = b.run_course("C1")
    assert (done, total) == (0, 1)


def test_run_course_dry_run_skips_readback(monkeypatch):
    b = _bot(dry_run=True)
    monkeypatch.setattr(b, "open_course", lambda cid: ({"name": "课"}, [_sec()]))
    monkeypatch.setattr(b, "fake_section", lambda *a, **k: (False, "[dry-run] 剩余 1s"))
    monkeypatch.setattr(b, "sections", lambda *a: [_sec()])   # dry-run 走只读计数
    assert b.run_course("C1") == (0, 1)


# ---------------------------------------------------------------- run_todo / run_hours

def test_run_todo_skips_future_and_quota(monkeypatch, capsys):
    b = _bot(dry_run=False)
    b.say = lambda *a, **k: print(*a)
    tasks = [_task("A"), _task("B"), _task("F", start=time_future())]
    monkeypatch.setattr(b, "undone_tasks", lambda: tasks)
    calls = []

    def fake_run(cid, **kw):
        calls.append(cid)
        if cid == "B":
            raise st.QuotaExhausted("配额满")
        b.last_result = {"done": 1, "total": 1, "failed": 0, "confirmed": True}
        return 1, 1
    monkeypatch.setattr(b, "run_course", fake_run)
    b.run_todo()
    out = capsys.readouterr().out
    assert calls == ["A", "B"]                    # 未来任务跳过、配额中断
    assert "未到开始时间" in out and "配额已满" in out


def time_future():
    import time
    return time.time() * 1000 + 86400000


def test_run_hours_reaches_target(monkeypatch, capsys):
    b = _bot(dry_run=False)
    b.say = lambda *a, **k: print(*a)
    seq = [{"hourSelf": 10.0, "requireCourseHour": 20.0},
           {"hourSelf": 21.0, "requireCourseHour": 20.0}]
    monkeypatch.setattr(b, "hours_self", lambda: seq.pop(0) if len(seq) > 1 else seq[0])
    monkeypatch.setattr(b, "undone_tasks", lambda: [_task("A")])
    monkeypatch.setattr(b, "run_course", lambda cid, **kw: (1, 1))
    b.run_hours("auto")
    assert "已达成目标" in capsys.readouterr().out


def test_run_hours_no_need_and_no_tasks(monkeypatch, capsys):
    b = _bot(dry_run=False)
    b.say = lambda *a, **k: print(*a)
    monkeypatch.setattr(b, "hours_self", lambda: {"hourSelf": 30, "requireCourseHour": 20})
    b.run_hours("auto")
    assert "已达标" in capsys.readouterr().out

    b2 = _bot(dry_run=False)
    b2.say = lambda *a, **k: print(*a)
    monkeypatch.setattr(b2, "hours_self",
                        lambda: {"hourSelf": 0, "requireCourseHour": 20})
    monkeypatch.setattr(b2, "undone_tasks", lambda: [])
    b2.run_hours("auto")
    assert "没有 未完成" in capsys.readouterr().out


def test_run_hours_flat_progress_stops(monkeypatch, capsys):
    b = _bot(dry_run=False)
    b.say = lambda *a, **k: print(*a)
    monkeypatch.setattr(b, "hours_self", lambda: {"hourSelf": 5.0, "requireCourseHour": 50.0})
    monkeypatch.setattr(b, "undone_tasks", lambda: [_task("A"), _task("B"), _task("C")])
    monkeypatch.setattr(b, "run_course", lambda cid, **kw: (1, 1))
    b.run_hours("10")
    assert "连续两门课后学时无增长" in capsys.readouterr().out


def test_run_hours_quota_and_exception(monkeypatch, capsys):
    b = _bot(dry_run=False)
    b.say = lambda *a, **k: print(*a)
    monkeypatch.setattr(b, "hours_self", lambda: {"hourSelf": 0, "requireCourseHour": 50})
    monkeypatch.setattr(b, "undone_tasks", lambda: [_task("A"), _task("B")])

    def fake(cid, **kw):
        if cid == "A":
            raise st.QuotaExhausted("满")
        return 1, 1
    monkeypatch.setattr(b, "run_course", fake)
    b.run_hours("5")
    assert "配额已满" in capsys.readouterr().out

    b2 = _bot(dry_run=False)
    b2.say = lambda *a, **k: print(*a)
    monkeypatch.setattr(b2, "hours_self", lambda: {"hourSelf": 0, "requireCourseHour": 50})
    monkeypatch.setattr(b2, "undone_tasks", lambda: [_task("A"), _task("B")])
    monkeypatch.setattr(b2, "run_course",
                        lambda cid, **kw: (_ for _ in ()).throw(RuntimeError("接口 500")))
    b2.run_hours("5")
    assert "异常" in capsys.readouterr().out


# ---------------------------------------------------------------- 解析与视图

def test_hours_self_returns_body(monkeypatch):
    b = _bot()
    b._req = lambda *a, **k: (200, {"hourSelf": 1})
    assert b.hours_self() == {"hourSelf": 1}
    b._req = lambda *a, **k: (200, None)
    assert b.hours_self() == {}


def test_resolve_course_variants(monkeypatch):
    b = _bot()
    uuid = "8a7c1075538e91720153acfd8a5134df"
    assert b.resolve_course(uuid)[0] == uuid
    monkeypatch.setattr(b, "list_tasks", lambda: [
        _task("A", status=3, name="安全专题"),
        _task("B", status=1, name="安全专题（续）")])
    cid, name = b.resolve_course("安全")
    assert cid == "B"                              # 未完成优先
    with pytest.raises(SystemExit, match="没有名称含"):
        b.resolve_course("不存在")


def test_resolve_course_multiple_prints(monkeypatch, capsys):
    b = _bot()
    b.say = lambda *a, **k: print(*a)
    monkeypatch.setattr(b, "list_tasks", lambda: [
        _task("A", name="同名课"), _task("B", name="同名课")])
    assert b.resolve_course("同名")[0] == "A"
    out = capsys.readouterr().out
    assert "命中 2 个" in out and "未完成" in out


def test_undone_tasks_filters(monkeypatch):
    b = _bot()
    monkeypatch.setattr(b, "list_tasks", lambda: [
        _task("A", status=1), _task("B", status=2), _task("C", status=3),
        _task("D", status=1, btype=3), _task("E", status=1) | {"expired": True}])
    assert [t["businessId"] for t in b.undone_tasks()] == ["A", "B"]


def test_person_courses_and_view(monkeypatch):
    b = _bot()
    items = [{"courseId": "C1", "finishStatus": 2, "isRequired": 1,
              "registerTime": 1, "courseInfo": {"name": "课一"}},
             {"courseId": "C1", "finishStatus": 2, "courseInfo": {"name": "重复"}},
             {"courseId": "C2", "finishStatus": 1, "courseInfo": {"name": "课二", "url": "u"}}]
    b._req = lambda *a, **k: (200, {"items": items})
    rows = b.person_courses(0)
    assert [r["bid"] for r in rows] == ["C1", "C2"]
    assert rows[0]["state"] == "已完成(复习)" and rows[0]["required"] == "必修"

    monkeypatch.setattr(b, "list_tasks", lambda: [])
    view = b.all_view_items()
    kinds = {r["type"] for r in view}
    assert "课程" in kinds and "专题" in kinds


def test_all_view_items_other_task_types(monkeypatch):
    b = _bot()
    monkeypatch.setattr(b, "person_courses", lambda bt: [])
    monkeypatch.setattr(b, "list_tasks", lambda: [
        _task("E1", btype=3, status=1), _task("E2", btype=3, status=2),
        _task("E3", btype=5, status=3)])
    states = {r["bid"]: r["state"] for r in b.all_view_items()}
    assert states == {"E1": "学习中", "E2": "学习中", "E3": "已完成"}


def test_cmd_list_output(monkeypatch, capsys):
    b = _bot()
    b.say = lambda *a, **k: print(*a)
    monkeypatch.setattr(b, "list_tasks", lambda: [_task("A", name="课A"),
                                                 _task("B", status=3, name="已完成")])
    monkeypatch.setattr(b, "hours_self", lambda: {"hourSelf": 1, "requireCourseHour": 10})
    st.cmd_list(b)
    out = capsys.readouterr().out
    assert "未完成任务 1 / 共 2" in out and "课A" in out


def test_resolve_user(monkeypatch):
    import mooc_api_login as m
    monkeypatch.setattr(m, "list_accounts", lambda: [
        {"key": "uid-1", "username": "u1", "display_name": "张三"},
        {"key": "uid-2", "username": "u2"}])
    assert st.resolve_user(None) is None
    assert st.resolve_user("uid-1") == "uid-1"
    assert st.resolve_user("张三") == "uid-1"
    with pytest.raises(SystemExit, match="不存在"):
        st.resolve_user("nobody")
    with pytest.raises(SystemExit, match="命中多个"):
        st.resolve_user("uid")
