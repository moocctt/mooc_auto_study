# -*- coding: utf-8 -*-
"""完成态复核: 前端两条请求 + 只读等待 + 回退修复 + 共享时间预算。

实测结论（2026-11-05, 真实账号）:
- 完成态由服务端**异步结算**写入, 客户端请求无法触发:
  course-progress-update 的四种参数组合与批量 course-section-progress 都回
  {"success": true} 却不改变 finishStatus;
- 观测延迟 2–18 分钟, 同批对象常在同一毫秒批量落库（354 条已完成记录里 80 条如此）;
- 关联课程父小节会**回退**: 5ec986a0 的父小节 settle 成 2 后被复核打回 0,
  因为子课程完成态当时还没落库。
所以: 发两条请求对齐前端 + 回读修复回退 + 只读轮询等待, 并把"尚未汇总"讲清楚。
"""
import pytest

import mooc_auto_study as st


def _bot(**kw):
    b = st.StudyBot(verbose=False, ws=False, dry_run=True, say=lambda *a, **k: None)
    for k, v in kw.items():
        setattr(b, k, v)
    return b


@pytest.fixture(autouse=True)
def no_sleep(monkeypatch):
    monkeypatch.setattr(st.time, "sleep", lambda *_: None)


def _sec(sid="s1", fin=1, typ=6, rid="r1"):
    return {"section_id": sid, "type": typ, "finish": fin, "name": "小节 " + sid,
            "resource_id": rid, "studied": 0, "rate": 0}


# ---------------------------------------------------------------- 两个请求

def test_sync_sections_posts_all_resource_ids(monkeypatch):
    b = _bot()
    got = {}
    monkeypatch.setattr(b, "_req",
                        lambda method, path, **kw: (got.update(path=path, **kw), (200, []))[1])
    b.sync_sections("c1", [{"resource_id": "r1"}, {"resource_id": "r2"},
                           {"resource_id": None}])
    assert got["path"] == st.API_SECTION_PROGRESS
    assert got["data"] == {"courseId": "c1", "resourceIds": "r1,r2"}


def test_progress_update_payload(monkeypatch):
    b = _bot()
    got = {}
    monkeypatch.setattr(b, "_req",
                        lambda method, path, **kw: (got.update(path=path, **kw), (200, {}))[1])
    b.progress_update("c1")
    assert got["path"] == st.API_PROGRESS_UPD
    assert got["data"] == {"encrypt": "false", "courseId": "c1"}


# ---------------------------------------------------------------- 只读等待

def test_course_finish_parses_list(monkeypatch):
    b = _bot()
    monkeypatch.setattr(b, "_req", lambda *a, **k: (200, [{"finishStatus": 2}]))
    assert b.course_finish("c1") == 2
    monkeypatch.setattr(b, "_req", lambda *a, **k: (200, []))
    assert b.course_finish("c1") is None


def test_wait_finish_immediate(monkeypatch):
    b = _bot()
    monkeypatch.setattr(b, "course_finish", lambda cid: 4)
    assert b.wait_finish("c1", timeout=10) is True


def test_wait_finish_timeout_says_so(monkeypatch):
    logs = []
    b = _bot(dry_run=False,
             say=lambda *a, **k: logs.append(" ".join(str(x) for x in a)))
    monkeypatch.setattr(b, "course_finish", lambda cid: 1)
    assert b.wait_finish("c1", timeout=0.05, interval=0.01) is False
    assert any("尚未汇总" in x for x in logs)


def test_wait_finish_survives_network_error(monkeypatch):
    """轮询时单次异常不该判定课程失败。"""
    def boom(cid):
        raise RuntimeError("网络抖动")

    b = _bot(dry_run=False)
    monkeypatch.setattr(b, "course_finish", boom)
    assert b.wait_finish("c1", timeout=0.05, interval=0.01) is False


# ---------------------------------------------------------------- run_course 接线

def test_run_course_waits_even_if_readback_lags(monkeypatch):
    """本次小节都刷成功了, 但回读仍显示未完成（滞后/回退）→ 仍要复核完成态。"""
    b = _bot(dry_run=False, wait_sync=600)
    monkeypatch.setattr(b, "open_course",
                        lambda cid: ({"name": "课", "register": True}, [_sec()]))
    monkeypatch.setattr(b, "sections", lambda *a: [_sec()])       # 回读一直滞后
    monkeypatch.setattr(b, "fake_section", lambda sec, **kw: (True, "ok"))
    monkeypatch.setattr(b, "sync_sections", lambda *a, **k: None)
    waited = []
    monkeypatch.setattr(b, "wait_finish", lambda cid, **kw: waited.append(cid) or False)

    done, total = b.run_course("c1")
    assert waited == ["c1"]           # 关键: 0/1 也要复核, 不能当失败
    assert b.last_result == {"done": 0, "total": 1, "failed": 0, "confirmed": False}


def test_run_course_does_not_wait_on_failure(monkeypatch):
    b = _bot(dry_run=False, wait_sync=600)
    monkeypatch.setattr(b, "open_course",
                        lambda cid: ({"name": "课", "register": True}, [_sec()]))
    monkeypatch.setattr(b, "sections", lambda *a: [_sec()])
    monkeypatch.setattr(b, "fake_section", lambda sec, **kw: (False, "上报失败"))
    monkeypatch.setattr(b, "sync_sections", lambda *a, **k: None)
    monkeypatch.setattr(b, "wait_finish", lambda *a, **k: pytest.fail("有失败时不该等"))
    assert b.run_course("c1") == (0, 1)
    assert b.last_result["failed"] == 1


def test_run_course_repairs_regressed_nested_section(monkeypatch):
    """父小节 settle 成 2 后被平台打回未完成 → 结束时重新 settle 一次。"""
    b = _bot(dry_run=False, wait_sync=600)
    parent = _sec("s1", fin=1, typ=10, rid="child-1")
    reads = [[dict(parent)], [dict(parent, finish=2)]]   # 回读两次: 回退 → 修复后完成
    monkeypatch.setattr(b, "open_course",
                        lambda cid: ({"name": "专题", "register": True}, [dict(parent)]))
    monkeypatch.setattr(b, "sections", lambda *a: reads.pop(0))
    monkeypatch.setattr(b, "sync_sections", lambda *a, **k: None)
    monkeypatch.setattr(b, "fake_section", lambda sec, **kw: (True, "子课程完成"))
    settled = []
    monkeypatch.setattr(b, "settle_nested",
                        lambda pc, cc, sid, **kw: settled.append((cc, sid)) or True)
    monkeypatch.setattr(b, "wait_finish", lambda cid, **kw: False)   # 本例只验回退修复

    done, total = b.run_course("c1")
    assert settled == [("child-1", "s1")]      # 回退被补 settle
    assert (done, total) == (1, 1)


# ---------------------------------------------------------------- run_todo

def test_run_todo_waits_only_at_end_with_shared_budget(monkeypatch):
    """批量跑时不在每个课程里等; 收尾共用一份预算, 不是每课 600s。"""
    b = _bot(dry_run=False, wait_sync=600)
    tasks = [{"name": f"课{c}", "businessId": c, "businessType": 2,
              "status": 1, "startTime": 0} for c in "ABCD"]
    monkeypatch.setattr(b, "undone_tasks", lambda: tasks)
    seen = []

    def fake_run(cid, **kw):
        seen.append((cid, b.wait_sync))
        b.last_result = {"done": 1, "total": 1, "failed": 0, "confirmed": None}
        return 1, 1

    monkeypatch.setattr(b, "run_course", fake_run)
    monkeypatch.setattr(b, "course_finish", lambda cid: 1)     # 一直未汇总
    clock = {"t": 0.0}
    monkeypatch.setattr(st.time, "time", lambda: clock["t"])
    monkeypatch.setattr(st.time, "sleep", lambda s: clock.__setitem__("t", clock["t"] + s))

    b.run_todo()
    assert seen == [("A", 0), ("B", 0), ("C", 0), ("D", 0)]     # 批量期间不等
    assert clock["t"] <= 630                                    # 共享 600s, 不是 4×600
    assert b.wait_sync == 600                                   # 结束后恢复


def test_run_todo_marks_pending_as_hourglass_not_warning(monkeypatch):
    """学完了但平台没汇总 → ⏳, 不是 ⚠️（用户别再重跑白扣配额）。"""
    logs = []
    b = _bot(dry_run=False, wait_sync=0,
             say=lambda *a, **k: logs.append(" ".join(str(x) for x in a)))
    monkeypatch.setattr(b, "undone_tasks", lambda: [
        {"name": "课A", "businessId": "A", "businessType": 2, "status": 1, "startTime": 0}])

    def fake_run(cid, **kw):
        b.last_result = {"done": 0, "total": 1, "failed": 0, "confirmed": False}
        return 0, 1

    monkeypatch.setattr(b, "run_course", fake_run)
    b.run_todo()
    assert any("⏳" in x and "课A" in x for x in logs)
    assert not any("⚠️" in x and "课A" in x for x in logs)


def test_run_course_waits_when_nothing_todo_but_all_done(monkeypatch):
    """--sync / 重跑: 小节早就全部完成（todo 为空），只差专题层汇总时也要轮询。"""
    b = _bot(dry_run=False, wait_sync=600)
    secs = [_sec("s1", fin=2), _sec("s2", fin=4)]
    monkeypatch.setattr(b, "open_course",
                        lambda cid: ({"name": "专题", "register": True}, secs))
    monkeypatch.setattr(b, "sections", lambda *a: secs)
    monkeypatch.setattr(b, "sync_sections", lambda *a, **k: None)
    waited = []
    monkeypatch.setattr(b, "wait_finish", lambda cid, **kw: waited.append(cid) or True)

    done, total = b.run_course("c1")
    assert (done, total) == (2, 2)
    assert waited == ["c1"]           # 关键: todo 为空不等于"不用确认"


def test_run_course_no_wait_for_empty_course(monkeypatch):
    """没有任何小节的课程不去轮询。"""
    b = _bot(dry_run=False, wait_sync=600)
    monkeypatch.setattr(b, "open_course",
                        lambda cid: ({"name": "空课", "register": True}, []))
    monkeypatch.setattr(b, "sections", lambda *a: [])
    monkeypatch.setattr(b, "sync_sections", lambda *a, **k: None)
    monkeypatch.setattr(b, "wait_finish", lambda *a, **k: pytest.fail("空课程不该等"))
    assert b.run_course("c1") == (0, 0)


# ---------------------------------------------------------------- Codex review 回归

def test_tui_hides_both_done_labels():
    from mooc_tui import _visible
    assert _visible({"state": "已完成"}, False) is False
    assert _visible({"state": "已完成(复习)"}, False) is False   # 原来只判 "已完成"
    assert _visible({"state": "学习中"}, False) is True
    assert _visible({"state": "已完成(复习)"}, True) is True


def test_run_todo_resets_result_on_exception(monkeypatch, capsys):
    """上一门课的 last_result 不能被失败的课复用，否则失败的课会显示 ✅/⏳。"""
    logs = []
    b = _bot(dry_run=False, wait_sync=0)
    b.say = lambda *a, **k: logs.append(" ".join(str(x) for x in a))
    tasks = [{"name": "课A", "businessId": "A", "businessType": 2, "status": 1, "startTime": 0},
             {"name": "课B", "businessId": "B", "businessType": 2, "status": 1, "startTime": 0}]
    monkeypatch.setattr(b, "undone_tasks", lambda: tasks)

    def run(cid, **kw):
        if cid == "B":
            raise RuntimeError("开课就炸了")
        b.last_result = {"done": 1, "total": 1, "failed": 0, "confirmed": True}
        return 1, 1

    monkeypatch.setattr(b, "run_course", run)
    b.run_todo()
    out = "\n".join(logs)
    assert "⚠️" in out                      # 课B 记为失败
    assert out.count("✅") == 1             # 只有课A 是完成


def test_run_todo_survives_probe_error(monkeypatch, capsys):
    """收尾共享轮询里单次查询异常，不能让整个汇总消失。"""
    logs = []
    b = _bot(dry_run=False, wait_sync=30)
    b.say = lambda *a, **k: logs.append(" ".join(str(x) for x in a))
    monkeypatch.setattr(b, "undone_tasks",
                        lambda: [{"name": "课A", "businessId": "A", "businessType": 2,
                                  "status": 1, "startTime": 0}])

    def run(cid, **kw):
        b.last_result = {"done": 1, "total": 1, "failed": 0, "confirmed": None}
        return 1, 1

    monkeypatch.setattr(b, "run_course", run)
    monkeypatch.setattr(b, "course_finish",
                        lambda cid: (_ for _ in ()).throw(RuntimeError("网络抖动")))
    clock = {"t": 0.0}
    monkeypatch.setattr(st.time, "time", lambda: clock["t"])
    monkeypatch.setattr(st.time, "sleep", lambda s: clock.__setitem__("t", clock["t"] + s))
    b.run_todo()
    out = "\n".join(logs)
    assert "========== 汇总 ==========" in out     # 汇总仍然打印出来
    assert "查询失败" in out


# ---------------------------------------------------------------- Greptile/Codex 第四轮

def test_exhausted_time_counts_as_pending_not_failed(monkeypatch):
    """视频学完但完成态延迟：remainingTime=0 且已上报过 → 待汇总，不是失败。"""
    b = _bot(dry_run=False, mode="video")     # mode=video 跳过音轨探测（否则会联网）
    calls = {"n": 0}

    def start(sid, back, ct=1):
        calls["n"] += 1
        return ("log", 60 if calls["n"] == 1 else 0)     # 第一轮有 60s，之后耗尽
    monkeypatch.setattr(b, "_start", start)
    monkeypatch.setattr(b, "_commit_video", lambda *a, **k: (200, {"finishStatus": 1}))
    ok, msg = b.fake_section({"section_id": "s1", "type": 6, "finish": 1,
                                     "name": "v", "resource_id": "r1",
                                     "studied": 0, "rate": 0}, chunk=600)
    assert ok and "待平台汇总" in msg


def test_run_course_refreshes_count_after_confirmed(monkeypatch):
    """wait 确认完成后回读一次，别把滞后计数返给父课程（否则误报子课程未完成）。"""
    b = _bot(dry_run=False, wait_sync=10)
    lagging = [_sec("s1", fin=1)]
    final = [_sec("s1", fin=2)]
    monkeypatch.setattr(b, "open_course",
                        lambda cid: ({"name": "课", "register": True}, list(lagging)))
    reads = [[dict(lagging[0])], [dict(final[0])], [dict(final[0])]]
    monkeypatch.setattr(b, "sections", lambda *a: reads.pop(0))
    monkeypatch.setattr(b, "sync_sections", lambda *a, **k: None)
    monkeypatch.setattr(b, "fake_section", lambda *a, **k: (True, "ok"))
    monkeypatch.setattr(b, "wait_finish", lambda cid, **kw: True)
    done, total = b.run_course("c1")
    assert (done, total) == (1, 1)                      # 汇总后的真实计数


def test_account_has_password_and_qr_key(monkeypatch, tmp_path):
    import mooc_api_login as m
    monkeypatch.setattr(m, "_TOKEN_DIR", str(tmp_path))
    monkeypatch.setattr(m, "ENV_FILE", str(tmp_path / ".env"))
    (tmp_path / ".env").write_text("MOOC_LOGIN=u1\nMOOC_PASS=p1\n", encoding="utf-8")
    monkeypatch.delenv("MOOC_USER", raising=False)
    assert m.account_has_password("u1") is True
    assert m.account_has_password("不存在") is False
    # 扫码账号默认用 userid 作 key（同名 display_name 不会互相覆盖）
    tok, key = m._store_token({"access_token": "t", "userid": "uid-1",
                               "display_name": "张三"}, kind="wechat")
    assert key == "uid-1"


def test_token_only_accounts_keeps_default_key(tmp_path, monkeypatch):
    import json
    import mooc_api_login as m
    monkeypatch.setattr(m, "_TOKEN_DIR", str(tmp_path))
    monkeypatch.setattr(m, "ENV_FILE", str(tmp_path / ".env"))
    (tmp_path / "mooc_token.json").write_text(
        json.dumps({"access_token": "t", "display_name": "张三", "userid": "uid"}),
        encoding="utf-8")
    accs = m.list_accounts()
    assert any(a["key"] == "default" for a in accs)     # 不能列成 "张三"（读不到）


def test_run_course_keeps_confirmed_result_when_refresh_fails(monkeypatch):
    """wait 确认完成后的回读失败，不能把已确认的课程改成失败（批量里会记 0/0）。"""
    b = _bot(dry_run=False, wait_sync=10)
    secs = [_sec("s1", fin=1)]
    monkeypatch.setattr(b, "open_course",
                        lambda cid: ({"name": "课", "register": True}, list(secs)))
    calls = {"n": 0}

    def sections(*a):
        calls["n"] += 1
        if calls["n"] == 1:
            return [dict(secs[0])]
        raise RuntimeError("回读超时")
    monkeypatch.setattr(b, "sections", sections)
    monkeypatch.setattr(b, "sync_sections", lambda *a, **k: None)
    monkeypatch.setattr(b, "fake_section", lambda *a, **k: (True, "ok"))
    monkeypatch.setattr(b, "wait_finish", lambda cid, **kw: True)
    done, total = b.run_course("c1")
    assert b.last_result["confirmed"] is True      # 仍是已确认
    assert (done, total) == (0, 1)                 # 用修复前读到的那份计数
