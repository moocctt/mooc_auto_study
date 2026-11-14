# -*- coding: utf-8 -*-
"""mooc_auto_study 覆盖补齐（一）：心跳、请求层、课程结构、单小节上报。"""
import time

import pytest

import mooc_auto_study as st


class Resp:
    def __init__(self, status=200, payload=None, ct="application/json", text="raw"):
        self.status_code = status
        self._p = payload
        self.headers = {"content-type": ct}
        self.text = text

    def json(self):
        if self._p is Exception:
            raise ValueError("bad")
        return self._p


class Sess:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []
        self.trust_env = True

    def request(self, method, url, **kw):
        self.calls.append((method, url, kw))
        return self.responses.pop(0)


def _bot(**kw):
    kw.setdefault("dry_run", True)
    b = st.StudyBot(verbose=False, ws=False, say=lambda *a, **k: None, **kw)
    return b


@pytest.fixture(autouse=True)
def no_sleep(monkeypatch):
    monkeypatch.setattr(st.time, "sleep", lambda *_: None)


# ---------------------------------------------------------------- 心跳

class FakeWS:
    instances = []

    def __init__(self, url):
        self.url = url
        self.sent = []
        self.sock = self
        self.closed = False
        FakeWS.instances.append(self)

    def send(self, msg):
        self.sent.append(msg)

    def settimeout(self, t):
        pass

    def recv_text(self, timeout=1):
        if len(self.sent) >= 2:
            raise RuntimeError("断开")
        return "otherClientStudy"

    def close(self):
        self.closed = True


def test_heartbeat_keeps_beating_until_stopped(monkeypatch):
    """recv 抛异常在内层被吞掉（视为掉线），外层继续发 PING 直到 stop。"""
    class Flaky(FakeWS):
        def recv_text(self, timeout=1):
            raise RuntimeError("断开")
    monkeypatch.setattr(st, "WSClient", Flaky)
    hb = st.Heartbeat("tok", interval=0.01, verbose=True)
    orig_send = Flaky.send

    def send(self, msg):
        orig_send(self, msg)
        if len(self.sent) >= 2:
            hb.stop()                      # 第二轮 PING 后停，避免无限循环
    Flaky.send = send
    hb.run()
    assert hb.beats >= 2


def test_heartbeat_stop_sets_flag():
    hb = st.Heartbeat("tok")
    hb.stop()
    assert hb.stop_flag.is_set()


# ---------------------------------------------------------------- 请求层

def test_req_401_refreshes_and_retries(monkeypatch):
    b = _bot()
    monkeypatch.setattr(st, "load_token_safe", lambda: {"access_token": "other"})
    monkeypatch.setattr(st, "fresh_token", lambda force=False: {"access_token": "new",
                                                                "token_type": "Bearer"})
    b.token = {"access_token": "old", "token_type": "Bearer"}
    b.s = Sess([Resp(401, {}), Resp(200, {"ok": 1})])
    code, body = b._req("GET", "api/v1/x")
    assert code == 200 and body == {"ok": 1}


def test_req_auth_error_code_retries(monkeypatch):
    b = _bot()
    monkeypatch.setattr(st, "load_token_safe", lambda: None)
    monkeypatch.setattr(st, "fresh_token", lambda force=False: {"access_token": "new"})
    b.s = Sess([Resp(200, {"errorCode": 90902}), Resp(200, {"ok": 1})])
    assert b._req("GET", "api/v1/x")[1] == {"ok": 1}


def test_req_non_json_body(monkeypatch):
    b = _bot()
    b.s = Sess([Resp(200, None, ct="text/html", text="hi")])
    code, body = b._req("GET", "api/v1/x")
    assert body is None


# ---------------------------------------------------------------- 课程结构

def test_list_tasks_and_sections(monkeypatch):
    b = _bot()
    b._req = lambda *a, **k: (200, {"items": [{"id": "a"}, {"id": "a"}], "recordCount": 2})
    assert [t["id"] for t in b.list_tasks()] == ["a"]
    b._req = lambda *a, **k: (200, [{"courseChapterSections": [
        {"referenceId": "s1", "resourceId": "r1", "name": "n1", "sectionType": 6,
         "progress": {"finishStatus": 2, "studyTotalTime": 30}}]}])
    secs = b.sections("C1", "v1", True)
    assert secs[0]["finish"] == 2 and secs[0]["studied"] == 30


def test_open_course(monkeypatch):
    b = _bot()
    seen = []

    def fake(method, path, **kw):
        seen.append(path)
        if "register" in path:
            return 200, {"versionId": "v1", "register": True, "name": "课"}
        return 200, []
    b._req = fake
    det, secs = b.open_course("C1")
    assert det["name"] == "课" and secs == [] and len(seen) == 2


def test_media_sources_classifies(monkeypatch):
    b = _bot()
    b._req = lambda *a, **k: (200, [
        {"path": "a/b.mp3"}, {"path": "a/b.mp4"}, {"path": "x", "def": 4}])
    mp3, mp4 = b.media_sources("r1")
    assert mp3 and mp4
    assert b.media_sources("r1") == (mp3, mp4)        # 缓存
    assert b.media_sources(None) == (None, None)


def test_start_and_commit_wrappers(monkeypatch):
    b = _bot()
    b._req = lambda *a, **k: (200, {"id": "log1", "remainingTime": 60})
    assert b._start("s1", 10) == ("log1", 60)
    b._req = lambda *a, **k: (500, None)
    assert b._start("s1", 10) == (None, None)
    b._req = lambda *a, **k: (200, {"finishStatus": 2})
    assert b._commit_video("log", 10, 5, 60)[1]["finishStatus"] == 2
    assert b._commit_doc("log", 5)[1]["finishStatus"] == 2
    assert b._commit_doc("log")[0] == 200


# ---------------------------------------------------------------- settle / 单小节

def test_settle_nested_retries_until_done(monkeypatch):
    b = _bot()
    seq = [(200, {"finishStatus": 1}), (200, {"finishStatus": 2})]
    b._start = lambda *a: ("log", 0)
    b._commit_doc = lambda *a, **k: seq.pop(0)
    b._req = lambda *a, **k: (200, [{"finishStatus": 2}])
    assert b.settle_nested("P", "C", "s1") is True


def test_fake_section_skip_types(monkeypatch):
    b = _bot()
    for typ in (4, 8, 9, 12, 13, 15):
        ok, msg = b.fake_section({"section_id": "s", "type": typ, "finish": 0,
                                  "name": "x", "resource_id": "r", "studied": 0})
        assert not ok and "真实作答" in msg


def test_fake_section_doc_types_and_progress(monkeypatch):
    b = _bot(dry_run=False)
    b.mode = "video"
    b._start = lambda *a: ("log", 60)
    b._commit_doc = lambda *a, **k: (200, {"finishStatus": 4})
    ok, msg = b.fake_section({"section_id": "s", "type": 1, "finish": 1,
                              "name": "pdf", "resource_id": "r", "studied": 0})
    assert ok and "完成" in msg


def test_fake_section_dry_run_reports_remaining(monkeypatch):
    b = _bot(dry_run=True)
    b.mode = "video"
    b._start = lambda *a: ("log", 300)
    ok, msg = b.fake_section({"section_id": "s", "type": 6, "finish": 1,
                              "name": "v", "resource_id": "r", "studied": 0})
    assert not ok and "[dry-run] 剩余 300s" in msg


def test_fake_section_quota_exhausted(monkeypatch):
    b = _bot(dry_run=False)
    b.mode = "video"
    b._start = lambda *a: ("log", 600)
    b._commit_video = lambda *a, **k: (200, {"finishStatus": 1})
    with pytest.raises(st.QuotaExhausted):
        b.fake_section({"section_id": "s", "type": 6, "finish": 1, "name": "v",
                        "resource_id": "r", "studied": 0})


def test_fake_section_retries_on_40909(monkeypatch):
    b = _bot(dry_run=False)
    b.mode = "video"
    logs = [("log1", 60), ("log2", 60)]

    def start(*a):
        return logs.pop(0) if logs else ("log3", 0)
    b._start = start
    codes = [(409, {"errorCode": 40909}), (200, {"finishStatus": 2})]
    b._commit_video = lambda *a, **k: codes.pop(0)
    ok, _ = b.fake_section({"section_id": "s", "type": 6, "finish": 1, "name": "v",
                            "resource_id": "r", "studied": 0})
    assert ok
