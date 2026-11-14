"""学习链路联调（本地假平台）：register → chapter-progress → start/video → 回读复核。

这层专门验证"无真实账号时也能证明"的行为：额度闸门、chunk 自适应、40909 重试、
配额熔断、401 穿透、dry-run 零副作用。真实语义仍要真会话复核，见报告"遗留风险"。
"""
from __future__ import annotations

import pytest

import mooc_study as MS
from mooc_tasks import AuthExpired


class FakeResp:
    def __init__(self, status: int, body):
        self.status_code = status
        self._body = body
        self.text = "" if body is None else str(body)

    def json(self):
        if self._body is None:
            raise ValueError("no json")
        return self._body


class FakePlatform:
    """最小可用平台：只实现本链路真正会打到的 5 个接口。"""

    def __init__(self, sections, *, accept_cap=None, reject_first_video=False,
                 freeze_remaining=False, unauthorized=False, course_name="假课程"):
        self.course_name = course_name
        self.accept_cap = accept_cap          # 单轮最多接受多少秒（模拟服务端限幅）
        self.reject_first_video = reject_first_video
        self.freeze_remaining = freeze_remaining
        self.unauthorized = unauthorized
        self.calls: list[tuple[str, str]] = []
        self.secs = {s["section_id"]: dict(s) for s in sections}
        for s in self.secs.values():
            s.setdefault("total", s.get("total", 300))
            s.setdefault("left", s["total"])
            s.setdefault("accepted", 0)
        self.sub_courses: dict[str, list[dict]] = {}
        self._rejected_once = False

    # -- 供断言使用 --
    def count(self, method: str, frag: str) -> int:
        return sum(1 for m, u in self.calls if m == method and frag in u)

    def add_sub_course(self, course_id: str, sections):
        self.sub_courses[course_id] = [dict(x) for x in sections]
        for s in self.sub_courses[course_id]:
            s.setdefault("total", s.get("total", 120))
            s.setdefault("left", s["total"])
            s.setdefault("accepted", 0)

    # -- requests.Session 接口 --
    def _pool(self, course_id=None):
        if course_id and course_id in self.sub_courses:
            return {s["section_id"]: s for s in self.sub_courses[course_id]}
        return self.secs

    def request(self, method, url, params=None, data=None, timeout=None):
        path = url.split("https://mooc.ctt.cn", 1)[-1]
        if path.startswith("/api/v1"):          # 与 _req 拼出来的完整 URL 对齐成接口路径
            path = path[len("/api/v1"):]
        self.calls.append((method, path))
        params = params or {}
        data = data or {}

        if self.unauthorized:
            return FakeResp(401, {"errorCode": 0, "message": "Access is Denied"})

        if path == MS.API_REGISTER:
            cid = str(data.get("courseId"))
            return FakeResp(200, {"name": f"{self.course_name}-{cid}",
                                  "versionId": f"v-{cid}", "register": True})

        if path == MS.API_CHAPTERS:
            cid = str(params.get("courseId"))
            pool = self._pool(cid)
            chapters = [{"courseChapterSections": [
                {"referenceId": s["section_id"], "resourceId": s["resource_id"],
                 "name": s["name"], "sectionType": s["type"],
                 "progress": {"finishStatus": 2 if s["left"] <= 0 else 0,
                              "studyTotalTime": s["accepted"]}}
                for s in pool.values()]}]
            return FakeResp(200, chapters)

        if path.startswith(MS.API_START + "/"):
            sid = path.rsplit("/", 1)[-1]
            sec = self.secs.get(sid) or next(
                (s for pool in self.sub_courses.values() for s in pool
                 if s["section_id"] == sid), None)
            if sec is None:
                return FakeResp(404, None)
            rem = sec["left"] if not self.freeze_remaining else sec["total"]
            return FakeResp(200, {"id": f"log-{sid}", "remainingTime": rem})

        if path in (MS.API_VIDEO, MS.API_DOC):
            sid = str(data.get("logId", "")).removeprefix("log-")
            sec = self.secs.get(sid) or next(
                (s for pool in self.sub_courses.values() for s in pool
                 if s["section_id"] == sid), None)
            if sec is None:
                return FakeResp(404, None)
            if self.reject_first_video and not self._rejected_once:
                self._rejected_once = True
                return FakeResp(400, {"errorCode": 40909, "message": "日志已失效"})
            try:
                want = int(float(data.get("studyTime") or 0))
            except (TypeError, ValueError):
                want = 0
            take = min(want, sec["left"])
            if self.accept_cap:
                take = min(take, self.accept_cap)
            if self.freeze_remaining:      # 配额已满：平台记了日志但一秒都不收
                take = 0
            sec["left"] -= take
            sec["accepted"] += take
            return FakeResp(200, {"finishStatus": 2 if sec["left"] <= 0 else 0})

        if path == MS.API_SECTION:
            return FakeResp(200, [{"finishStatus": 2}])

        if path == MS.API_PROGRESS_UPD or path == MS.API_COURSE_FRONT + "/registerStudy":
            return FakeResp(200, {})

        if path.startswith(MS.API_COURSE_FRONT + "/info/"):
            cid = path.rsplit("/", 1)[-1]
            return FakeResp(200, {"courseChapters": [
                {"courseChapterSections": [
                    {"id": s["section_id"], "attachmentId": s["resource_id"],
                     "name": s["name"], "fileType": "mp4"}
                    for s in self.sub_courses.get(cid, [])]}]})

        if path == MS.API_COURSE_BY_IDS:
            cid = str(params.get("ids") or "").split(",")[0]
            return FakeResp(200, [{"id": cid, "name": self.course_name,
                                   "versionId": f"v-{cid}", "register": True}])

        if path == MS.API_COURSE_INFO:
            return FakeResp(200, [{"finishStatus": 2}])

        return FakeResp(404, None)


@pytest.fixture()
def fast(monkeypatch):
    """把 sleep 与随机等待抹平，联调只关心状态机。"""
    monkeypatch.setattr(MS.time, "sleep", lambda *_: None)
    monkeypatch.setattr(MS, "SETTLE_WAIT", 0)
    return monkeypatch


def _sec(sid="s1", name="第一小节", stype=6, total=300, resource="r1"):
    return {"section_id": sid, "resource_id": resource, "name": name,
            "type": stype, "finish": 0, "studied": 0, "total": total}


def test_media_section_finishes_in_one_round(fast):
    plat = FakePlatform([_sec(total=300)])
    rep: dict = {}
    done, total = MS.run_course(plat, "c1", chunk=600, report=rep)

    assert (done, total) == (1, 1)
    assert rep["ok"] == 1 and rep["fail"] == 0
    assert rep["submitted"] == 300, "上报秒数应等于平台实际接受的秒数"
    assert plat.count("GET", MS.API_START) == 1
    assert plat.count("POST", MS.API_VIDEO) == 1


def test_chunk_shrinks_when_server_accepts_less(fast):
    """服务端每轮只收 120s：chunk 必须自适应降级，否则轮次会被固定上限卡成假失败。"""
    plat = FakePlatform([_sec(total=300)], accept_cap=120)
    rep: dict = {}
    done, _ = MS.run_course(plat, "c1", chunk=600, report=rep)

    assert done == 1
    assert rep["submitted"] == 300
    assert plat.count("POST", MS.API_VIDEO) >= 3, "限幅情况下必须多轮才学完"


def test_quota_exhausted_when_remaining_never_drops(fast):
    """剩余时长连续两轮不降 = 当日配额已满，必须熔断而不是空转。"""
    plat = FakePlatform([_sec(total=300)], freeze_remaining=True)
    with pytest.raises(MS.QuotaExhausted) as ei:
        MS.run_course(plat, "c1", chunk=300)
    assert "配额" in str(ei.value)


def test_40909_is_retried_not_reported_as_failure(fast):
    """旧学习日志被平台拒（40909）时应换日志重试，不能算本节失败。"""
    plat = FakePlatform([_sec(total=300)], reject_first_video=True)
    rep: dict = {}
    done, _ = MS.run_course(plat, "c1", chunk=600, report=rep)
    assert done == 1
    assert rep["fail"] == 0
    assert plat.count("POST", MS.API_VIDEO) == 2, "被拒一次后应重试成功"


def test_401_is_not_swallowed_by_run_course(fast):
    """401 必须穿透成 AuthExpired（退出码 2），不能被当成"本节异常"记成 FAIL。"""
    plat = FakePlatform([_sec()], unauthorized=True)
    with pytest.raises(AuthExpired):
        MS.run_course(plat, "c1", chunk=600)


def test_budget_stops_before_opening_next_section(fast):
    """额度假门：本次目标秒数用完后，不允许再开下一小节。"""
    plat = FakePlatform([_sec("s1", total=300), _sec("s2", "第二小节", total=300)])
    rep: dict = {}
    done, total = MS.run_course(plat, "c1", chunk=600, report=rep, budget=300)

    assert (done, total) == (1, 2)
    assert rep["submitted"] == 300
    started = {u.rsplit("/", 1)[-1] for m, u in plat.calls if u.startswith(MS.API_START)}
    assert started == {"s1"}, "超额前必须停手，s2 不该被 start"


def test_budget_is_enforced_inside_a_long_section(fast):
    """小节级额度：单节要 600s、本次只要 90s 时必须停手，不能刷到 600s。

    真实事故（2026-11-14）：url 小节一次刷了 9407s，把 --hours 0.03 冲成 3.6 学时。
    """
    plat = FakePlatform([_sec("s1", total=600)])
    rep: dict = {}
    MS.run_course(plat, "c1", chunk=120, report=rep, budget=90)

    assert rep["submitted"] <= 90, rep
    assert rep["partial"] is True
    assert plat.secs["s1"]["finish"] not in MS.DONE_FINISH


def test_nested_child_gets_the_remaining_budget(fast):
    """嵌套子课程不能独占额度：父层剩下的秒数要传下去。"""
    sub = _sec("sub1", "子课小节", total=600)
    plat = FakePlatform([_sec("p1", "父", stype=MS.NESTED_TYPE, total=0)])
    plat.add_sub_course("child", [sub])
    rep: dict = {}
    MS.run_course(plat, "c1", chunk=120, report=rep, budget=60)

    assert rep["submitted"] <= 60, rep


def test_dry_run_does_not_touch_progress(fast):
    """dry-run 不能建学习记录（那会真占配额），也不该把待学记成失败。"""
    plat = FakePlatform([_sec(), _sec("s2", "第二小节")])
    rep: dict = {}
    done, total = MS.run_course(plat, "c1", chunk=600, dry_run=True, report=rep)

    assert (done, total) == (0, 2)
    assert plat.count("GET", MS.API_START) == 0
    assert plat.count("POST", MS.API_VIDEO) == 0
    assert plat.count("POST", MS.API_REGISTER) == 0, "dry-run 不能报名（会真建学习记录）"
    assert plat.count("POST", MS.API_COURSE_FRONT + "/registerStudy") == 0
    assert rep["fail"] == 0


def test_nested_course_seconds_are_counted_in_budget(fast):
    """关联课程（type=10）的子课程秒数必须计进本次额度，否则会超额扣学时。"""
    plat = FakePlatform([_sec("p1", "关联课程小节", stype=10, total=1, resource="c9"),
                         _sec("s2", "第二小节", total=300)])
    plat.add_sub_course("c9", [{"section_id": "k1", "resource_id": "k1r",
                                "name": "子课程小节", "type": 6, "finish": 0,
                                "studied": 0, "total": 200}])
    rep: dict = {}
    done, total = MS.run_course(plat, "c1", chunk=600, report=rep, budget=100)

    assert done == 0 and total == 2, "只有子课程学完，父小节还没完成"
    # 额度必须传给子课程：本次只要 100s，子课程就不能把 200s 全刷掉
    assert rep["submitted"] <= 100, rep
    assert rep["sent"] <= 100, rep
    started = {u.rsplit("/", 1)[-1] for m, u in plat.calls if u.startswith(MS.API_START)}
    assert "s2" not in started, "额度已满：第二小节不该被 start"


def test_wait_finish_respects_deadline(fast):
    """多个目标串跑时，总等待不能超过 deadline。"""
    import time as real_time

    plat = FakePlatform([_sec()])
    assert MS.wait_finish(plat, "c1", timeout=600,
                          deadline=real_time.time() - 1) is True, "课程层返回完成即 True"
    plat2 = FakePlatform([_sec()])
    plat2_course_info = [{"finishStatus": 1}]

    def req(method, path, params=None, data=None):
        return 200, plat2_course_info if path == MS.API_COURSE_INFO else {}

    original = MS._req
    MS._req = req
    try:
        t0 = real_time.time()
        ok = MS.wait_finish(plat2, "c1", timeout=600, deadline=t0 - 1)
        assert ok is False
        assert real_time.time() - t0 < 5, "deadline 已过应立即返回，不该等满 timeout"
    finally:
        MS._req = original
