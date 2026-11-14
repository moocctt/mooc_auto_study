# -*- coding: utf-8 -*-
"""课程库课程学习（F14'）：registerStudy 报名 → info/<id> 取章节 → clientType=0 + 加密上报。

实测依据（浏览器 HAR 2026-11-05）：
  POST registerStudy            body: courseId=<id>&type=1&isRequired=0
  GET  course-front/info/<id>   query: source=1&type=1  → courseChapters[].courseChapterSections[]
                                  （section.id = start-progress 的 sectionId，attachmentId = 资源 id）
  GET  start-progress/<sid>?clientType=0
  POST video-progress           body 全字段 AES-128-ECB：logId/lessonLocation/studyTime/
                                resourceTotalTime/organizationId + singleMark(随机 UUID)

本文件先于实现编写（TDD 红），实现后全绿。
"""
import uuid

import pytest

import mooc_auto_study as st


def _bot():
    return st.StudyBot(verbose=False, ws=False, mode="video", dry_run=True,
                       wait_sync=0, say=lambda *a, **k: None)


# ---------------------------------------------------------------- 报名 + 章节

def test_open_library_course_registers_and_parses_sections(monkeypatch):
    b = _bot()
    calls = []

    def fake(method, path, params=None, data=None):
        calls.append((method, path, dict(params or {}), dict(data or {})))
        if "registerStudy" in path:
            return 200, {"id": "rec-1", "finishStatus": 0}
        if "/info/" in path:
            return 200, {"name": "消防安全管理", "courseChapters": [
                {"courseChapterSections": [
                    {"id": "s1", "attachmentId": "r1", "name": "第一节", "fileType": "mp4"},
                    {"id": "s2", "attachmentId": "r2", "name": "第二节", "fileType": "mp3"}]}]}
        return 200, None

    monkeypatch.setattr(b, "_req", fake)
    det, secs = b.open_library_course("CID")

    assert det["_library"] is True          # 标记：课程库课程
    # 报名 body 必须是 type=1&isRequired=0
    reg = calls[0]
    assert reg[1].endswith("/registerStudy")
    assert reg[3] == {"courseId": "CID", "type": 1, "isRequired": 0}
    # 章节解析：id→section_id、attachmentId→resource_id、fileType→type
    assert [(s["section_id"], s["resource_id"], s["type"]) for s in secs] == [
        ("s1", "r1", 6), ("s2", "r2", 5)]


def test_open_course_falls_back_to_library(monkeypatch):
    """"我的课程"路径的 register 失败（课程库课程 422）→ 自动回退课程库路径。"""
    b = _bot()
    seen = []

    def fake(method, path, params=None, data=None):
        seen.append(path)
        if path.endswith("register"):
            return 422, {"errorCode": 40206}
        if "registerStudy" in path:
            return 200, {"id": "rec"}
        if "/info/" in path:
            return 200, {"courseChapters": []}
        return 200, None

    monkeypatch.setattr(b, "_req", fake)
    det, secs = b.open_course("CID")
    assert det["_library"] is True and secs == []
    assert any("registerStudy" in p for p in seen)


# ---------------------------------------------------------------- 加密上报

def test_commit_video_enc_encrypts_all_fields(monkeypatch):
    b = _bot()
    got = {}

    def fake(method, path, params=None, data=None):
        got.update(data or {})
        return 200, {"finishStatus": 2}

    monkeypatch.setattr(b, "_req", fake)
    b._commit_video_enc("log-1", 300, 120, 600)

    from mooc_api_login import dec
    assert dec(got["logId"]) == "log-1"
    assert dec(got["studyTime"]) == "300"
    assert dec(got["lessonLocation"]) == "120"
    assert dec(got["resourceTotalTime"]) == "600"
    assert dec(got["organizationId"]) == "1"
    # singleMark 是随机 UUID 的密文，且两次调用不同
    mark = dec(got["singleMark"])
    uuid.UUID(mark)                          # 合法 UUID
    b._commit_video_enc("log-2", 1, 1, 1)
    assert dec(got["singleMark"]) != mark
    assert "encrypt" not in got              # 加密版不带 encrypt 字段


def test_commit_video_enc_never_plaintext(monkeypatch):
    """明文上报会被平台拒（422），确保发出的值都是 base64 密文、不是裸数字。"""
    b = _bot()
    payloads = []
    monkeypatch.setattr(b, "_req",
                        lambda m, p, params=None, data=None: (payloads.append(data), (200, {}))[1])
    b._commit_video_enc("log", 5, 5, 5)
    for k in ("logId", "studyTime", "lessonLocation", "resourceTotalTime", "singleMark"):
        with pytest.raises(Exception):
            int(payloads[0][k])              # 裸数字/明文 UUID 会解析成功 → 应失败
        assert payloads[0][k].endswith("==") or len(payloads[0][k]) >= 16


# ---------------------------------------------------------------- clientType

def test_start_uses_client_type(monkeypatch):
    b = _bot()
    seen = []

    def fake(method, path, params=None, data=None):
        seen.append(dict(params or {}))
        return 200, {"id": "log", "remainingTime": 60}

    monkeypatch.setattr(b, "_req", fake)
    b._start("s1", 10, 0)                    # 课程库课程
    b._start("s1", 10)                       # 我的课程（默认）
    assert seen[0]["clientType"] == 0 and seen[1]["clientType"] == 1


def test_study_section_library_path_encrypts(monkeypatch):
    """library=True 时走加密上报且 clientType=0。"""
    b = _bot()
    b.dry_run = False
    calls = []
    monkeypatch.setattr(b, "_start", lambda sid, back, ct=1: (calls.append(ct), ("log", 600))[1])
    monkeypatch.setattr(b, "_commit_video_enc",
                        lambda *a: (calls.append("enc"), (200, {"finishStatus": 2}))[1])
    sec = {"section_id": "s1", "type": 6, "finish": 1, "name": "v",
           "resource_id": "r1", "studied": 0}
    ok, msg = b.fake_section(sec, chunk=600, library=True)
    assert ok and "完成" in msg
    assert calls[0] == 0 and "enc" in calls     # clientType=0 + 加密上报
