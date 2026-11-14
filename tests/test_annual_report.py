"""mooc_annual.py 渲染边界：完成率缺失、totalScore 缺失、双零学时、校验不一致。

这些用例对应真实踩过的坑：平台没设要求学时（完成率 None）或没返回 totalScore 时，
Markdown / HTML 渲染直接抛 TypeError；两组学时都为 0 时再除一次零。
"""
from __future__ import annotations

import pytest

import mooc_annual as A


def _side(req: float, done: float, scene: str) -> dict:
    return {"场景": scene, "已完成": done, "要求": req,
            "差额": round(done - req, 2) if req else None,
            "缺口": round(req - done, 2) if req else None,
            "完成率": round(done / req * 100, 1) if req else None,
            "达标": bool(req) and done >= req}


def _summary(req_net, req_cls, done_net, done_cls, score) -> dict:
    out = {"网络自学": _side(req_net, done_net, "网络自学"),
           "集中培训": _side(req_cls, done_cls, "集中培训"),
           "总学分": score}
    if score is not None:
        out["总学分校验"] = {"说明": "合计",
                             "两组之和": f"{done_net + done_cls:.2f}",
                             "一致": abs(float(score) - (done_net + done_cls)) < 0.011}
    return out


def _training_stats(**over) -> dict:
    base = {"year": 2026, "year_count": 1, "year_done_count": 1, "achieved_hours": 2.0,
            "by_year": {"2026": 2.0}, "basis": "start", "detail_failed": 0,
            "year_basis_fallback": 0, "ongoing": [],
            "year_items": [{"title": "班次A", "class_hour": 2.0, "graduate_status": 4,
                            "graduate_label": "已结业", "start": "2026-03-01",
                            "end": "2026-03-03", "place": "省局",
                            "url": "https://example/c", "class_id": "1"}]}
    base.update(over)
    return base


def _rep(summary: dict, training_stats: dict | None = None) -> dict:
    year = {"year": 2026, "total": 4, "done": 2, "pending": 2, "required_total": 4,
            "required_pending": 2, "required_done": 2}
    return {
        "now": "2026-11-14", "year": 2026,
        "meta": {"year": 2026, "账号": "tester",
                 "generated_at": "2026-11-14T09:00:00", "token_expires": None,
                 "refresh": False, "platform_total_tasks": 10,
                 "member": {"name": "测试学员", "org": "测试单位"}},
        "session": {}, "summary": summary, "hours": summary,
        "duration": {"total_seconds": 45210, "detail_failed": 0, "course_count": 3},
        "task_stats": {
            "total": 10, "done": 9, "doing": 1, "todo": 0, "year": year,
            "all": {"total": 10, "done": 9, "doing": 1, "todo": 0},
            "types": [{"type": "专题课程", "total": 7, "done": 6},
                      {"type": "培训班", "total": 3, "done": 3}],
            "by_year": [{"year": 2025, "total": 3, "done": 3},
                        {"year": 2026, "total": 4, "done": 2}],
        },
        "year_tasks": [],
        "year_pending": [{"title": "待办A", "type": "专题课程", "end": "2026-12-31",
                          "required": True, "url": "https://example/x"},
                         {"title": "待办B", "type": "培训班", "end": "2026-06-30",
                          "required": False, "url": "https://example/y"}],
        "year_done": [{"title": "已完成A", "type": "专题课程", "required": True,
                       "url": "https://example/z", "start": "2026-01-01",
                       "end": "2026-02-01"}],
        "classes": [{"title": "班次A", "status": "已结业", "hours": 2.0,
                     "start": "2026-03-01", "end": "2026-03-03",
                     "url": "https://example/c", "place": "省局", "phase": "已结束",
                     "graduate_status": 4, "code": "C001", "class_id": "1",
                     "class_hour": 2.0, "graduate_label": "已结业"}],
        "trainings": [{"title": "班次A", "class_hour": 2.0, "graduate_status": 4,
                       "status": "已结业", "start": "2026-03-01", "end": "2026-03-03",
                       "class_id": "1", "code": "C001", "place": "省局",
                       "achieved_hours": 2.0, "detail_ok": True,
                       "graduate_label": "已结业"}],
        "training_stats": training_stats or _training_stats(),
        "overdue": [], "trainings_cached": False,
    }


CASES = {
    "完成率为None（平台未设要求学时）": (_summary(0, 0, 46.0, 2.0, "48.00"), None),
    "totalScore 缺失": (_summary(34, 9, 46.0, 2.0, None), None),
    "两组学时都为 0": (_summary(0, 0, 0.0, 0.0, None),
                   _training_stats(year_count=0, year_done_count=0, achieved_hours=0.0,
                                   by_year={}, detail_failed=2,
                                   year_basis_fallback=1, year_items=[])),
    "总学分校验不一致": (_summary(34, 9, 46.0, 2.0, "40.00"), None),
}


@pytest.mark.parametrize("name", list(CASES))
def test_render_never_crashes(name):
    summary, ts = CASES[name]
    rep = _rep(summary, ts)
    rep["derived"] = A.derive(rep)
    md = A.render_md(rep, "")
    html = A.render_html(rep, "", None)
    assert "年度学习报告" in md
    assert "<html" in html


@pytest.mark.parametrize("name", list(CASES))
def test_no_unfilled_placeholder(name):
    summary, ts = CASES[name]
    rep = _rep(summary, ts)
    rep["derived"] = A.derive(rep)
    md = A.render_md(rep, "")
    html = A.render_html(rep, "", None)
    for text in (md, html):
        assert "None%" not in text, "None 被当成百分比打出来了"
        assert "None 学时" not in text, "None 混进了学员数字段"
        assert ">NaN<" not in text and "NaN%" not in text


def test_missing_total_score_is_explained():
    summary, _ = CASES["totalScore 缺失"]
    rep = _rep(summary)
    rep["derived"] = A.derive(rep)
    text = A.render_md(rep, "") + A.render_html(rep, "", None)
    assert "未返回" in text or "未设" in text


def test_login_links_are_not_printed_without_token():
    summary, _ = CASES["totalScore 缺失"]
    rep = _rep(summary)
    rep["derived"] = A.derive(rep)
    md = A.render_md(rep, "")
    assert "?token=" not in md, "没有凭据时不能把免登录链接写进 Markdown"
    assert "<a href=" not in md or "token" not in md.split("<a href=")[1][:80]
