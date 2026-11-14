"""真实接口契约的回归（2026-11-14 用真实账号核过的事实）。

这几条以前只有"我以为"：字段缺了会静默降级成假数据，所以在离线测试里钉死。
"""
import mooc_study as MS


def test_course_detail_keeps_version_id(monkeypatch):
    # find-by-ids 的 versionId 是 chapter-progress 的必填参数；丢了就 422，
    # 只读复查会把"已学完"读成"一节都没学"。
    def fake_req(s, method, path, params=None, data=None):
        assert path == MS.API_COURSE_BY_IDS
        return 200, [{"id": "c1", "name": "课", "businessType": 0, "courseHour": 2,
                      "versionId": "v-9", "register": True}]

    monkeypatch.setattr(MS, "_req", fake_req)
    det = MS.course_detail(None, "c1")
    assert det["versionId"] == "v-9"
    assert det["register"] is True


def test_platform_today_hours_is_none_when_field_unusable(monkeypatch):
    # 真实账号：学完 2340s 后 hourSelf +0.9，但 person-courselog 的 studyTotalTime 仍是 0。
    # 这种情况必须返回 None（平台未提供），不能返回 0.0（会被当成"今天没学"）。
    def fake_req(s, method, path, params=None, data=None):
        assert path == MS.API_COURSELOG
        return 200, {"items": [{"id": "a", "studyTotalTime": 0},
                               {"id": "b", "studyTotalTime": 0}], "recordCount": 2}

    monkeypatch.setattr(MS, "_req", fake_req)
    assert MS.platform_today_hours(None) is None


def test_platform_today_hours_sums_when_present(monkeypatch):
    def fake_req(s, method, path, params=None, data=None):
        # businessType 0/2 会重叠返回同一条记录（id 相同），必须按 id 去重
        return 200, {"items": [{"id": "same", "studyTotalTime": 1800}]}

    monkeypatch.setattr(MS, "_req", fake_req)
    assert MS.platform_today_hours(None) == 0.5
