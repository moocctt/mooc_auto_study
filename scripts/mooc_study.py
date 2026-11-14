#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""按目标自动完成学习任务（mooc.ctt.cn）—— 仅限本人账号，须用户显式要求。

三种目标：
  --course <名称|businessId|页面URL>   学完指定专题/课程
  --hours N                          刷够 N 学时（按 requireCourseHour − hourSelf 的缺口自动选课）
  --todo                             学完"我的任务"里全部 未完成/未开始 的课程与专题
  --list                             只列出目标与学时缺口，不动平台

协议要点（2026-11 实测，依据见 SKILL.md 与 references/task-api.md）：
  1. 每轮上报都要新建学习日志：GET start-progress/<sectionId>?clientType=1&createTime=<ms>，
     createTime 可回溯到过去 —— 服务端只校验 studyTime ≤ now − createTime；(旧日志重复提交报 40909)
  2. 音视频 POST video-progress（encrypt=false & logId & studyTime & lessonLocation &
     resourceTotalTime & flush），文档类 POST doc-progress（encrypt=false & logId）；
  3. 完成态 finishStatus：2=复习（已完成）、4=完成，两者都算完成；
  4. 关联课程(sectionType=10)：递归学完子课程 → POST course-section-progress 建父记录 →
     settle（doc-progress 心跳）→ 平台异步复核；父小节可能被复核打回，课程结束时会再回读补 settle；
  5. 专题层完成态是服务端异步结算（实测 2–18 分钟），客户端请求无法触发 → --wait-sync 只做只读轮询。

学习时长按日累计，平台上限 24 小时；remainingTime 连续两轮不下降即判定当天配额已满并停止。
"""

from __future__ import annotations

import argparse
import datetime
import json
import random
import re
import sys
import time
import uuid as uuidlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from mooc_tasks import (API, AuthExpired, api_session, fetch_summary,  # noqa: E402
                        load_session)

TYPE_NAME = {1: "pdf", 2: "image", 3: "url", 4: "scorm", 5: "mp3", 6: "mp4",
             7: "epub", 8: "作业", 9: "考试", 10: "关联课程", 12: "调研",
             13: "assessment", 15: "kj"}
TASK_TYPE = {1: "课程", 2: "专题", 3: "考试", 4: "调研", 5: "班级", 6: "直播"}
MEDIA_TYPES = {5, 6}
NESTED_TYPE = 10
SKIP_TYPES = {4, 8, 9, 12, 13, 15}      # 需真实作答, 心跳无意义
DONE_FINISH = {2, 4}                    # 2=复习(已完成), 4=完成
TASK_UNDONE = (1, 2)                    # 1 未开始 / 2 进行中
MAX_DEPTH = 2
SETTLE_WAIT = 45                        # 回读前等平台异步结算（实测 2–18 分钟，至少先等一轮）

API_TASKS = "/human/task"
# 我的课程/专题（含不在"我的任务"里的自选课、专题内嵌子课程）
API_PERSON_COURSE = "/course-study/course-study-progress/personCourse-list"
# 学习记录（含未完成/最近访问），按时间区间翻页
API_COURSELOG = "/course-study/course-study-progress/person-courselog"
# 按 id 取任意课程详情（不需要该课在"我的任务/我的课程"里）
API_COURSE_BY_IDS = "/course-study/course-info/front/find-by-ids"
# 平台课程库全局搜索（type=0 课程 / type=2 专题；publishClient=1 必填）
API_GLOBAL_SEARCH = "/course-study/course-front/findPageForGlobalSearch"
API_COURSE_FRONT = "/course-study/course-front"     # info/<id> 详情、registerStudy 报名
# 课程库课程的 fileType → 小节类型（与 sectionType 对齐）
FTYPE = {"mp4": 6, "mp3": 5, "pdf": 1, "image": 2, "url": 3, "epub": 7}
API_REGISTER = "/course-study/course-front/register"
API_CHAPTERS = "/course-study/subject/chapter-progress"
API_START = "/course-study/course-front/start-progress"
API_VIDEO = "/course-study/course-front/video-progress"
API_DOC = "/course-study/course-front/doc-progress"
API_SECTION = "/course-study/course-front/course-section-progress"
API_COURSE_INFO = "/course-study/course-front/course-info-progress"
API_PROGRESS_UPD = "/course-study/course-front/course-progress-update"


from tobacco import CN_TZ, cn_now, cn_today  # noqa: E402  时区口径与其它脚本一致

def _result(mode: str, *, courses: int = 0, done: int = 0, total: int = 0,
            failed: int = 0, hours_gained=None, **extra) -> None:
    """统一的机器可读收尾行：字段固定，任何分支都带全，便于下游解析。"""
    fields = [f"ok={'true' if not failed else 'false'}", f"mode={mode}",
              f"courses={courses}", f"done={done}", f"total={total}",
              f"failed={failed}",
              f"hours_gained={'null' if hours_gained is None else hours_gained}"]
    fields += [f"{k}={v}" for k, v in extra.items()]
    print("RESULT|" + "|".join(fields), flush=True)


class QuotaExhausted(RuntimeError):
    """当日学时配额已满：上报仍 200，但 remainingTime 不再下降。"""



def say(*args) -> None:
    print(*args, flush=True)


# ---------------------------------------------------------------- 基础请求

def _req(s, method: str, path: str, params: dict | None = None, data: dict | None = None):
    """返回 (status, 解析后的 JSON 或 None)。平台部分响应不带 content-type，只能直接尝试解析。"""
    r = s.request(method, API + path, params=params, data=data, timeout=25)
    body = None
    try:
        body = r.json()
    except ValueError:
        body = None
    if r.status_code == 401:
        raise AuthExpired("401：token 失效或已过期，请先重新登录（mooc_tasks.py login-password）")
    return r.status_code, body


def list_tasks(s) -> list[dict]:
    """"我的任务"全量（去重）。status: 1 未开始 / 2 进行中 / 3 已完成。"""
    items, page = [], 1
    while True:
        code, body = _req(s, "GET", API_TASKS, params={
            "page": page, "pageSize": 500, "status": "", "filterAuthExam": 1})
        if code != 200 or not isinstance(body, dict):
            raise RuntimeError(f"human/task 读取失败 HTTP {code}: {str(body)[:120]}")
        its = body.get("items") or []
        items += its
        if not its or len(items) >= (body or {}).get("recordCount", 0):
            break
        page += 1
    seen, uniq = set(), []
    for t in items:
        if t["id"] not in seen:
            seen.add(t["id"])
            uniq.append(t)
    return uniq


def undone_tasks(s) -> list[dict]:
    """未完成/未开始的课程与专题。已完成(status=3)与已过期(expired=true)都不动。"""
    return [t for t in list_tasks(s)
            if t.get("status") in TASK_UNDONE and t.get("businessType") in (1, 2)
            and not t.get("expired")]


def search_courses(s, keyword: str, page_size: int = 20) -> list[dict]:
    """搜索平台课程库（含未加入"我的任务/我的课程"的课程与专题）。

    type: 0=课程, 2=专题（实测 2026-11-05；type=1/3 无结果）。
    publishClient=1 为必填，缺则 422。
    """
    out = []
    for kind_type, kind_name in ((0, "课程"), (2, "专题")):
        page = 1
        while True:                                   # 翻页取全（命中数常超过单页上限）
            _, body = _req(s, "GET", API_GLOBAL_SEARCH, params={
                "type": kind_type, "publishClient": 1, "searchContent": keyword,
                "page": page, "pageSize": page_size, "_": int(time.time() * 1000)})
            items = (body or {}).get("items") or []
            for it in items:
                cid = it.get("id")
                if not cid:
                    continue
                out.append({"id": cid, "name": it.get("name") or "", "kind": kind_name,
                            "courseHour": it.get("courseHour") or 0,
                            "visits": it.get("visits") or 0})
            total = (body or {}).get("recordCount") or 0
            if not items or page * page_size >= total:
                break
            page += 1
    return out


def course_detail(s, course_id: str) -> dict | None:
    """按 id 取课程详情（名称/学时/类型）。平台内任意课程都可查，不要求已加入个人列表。"""
    _, body = _req(s, "GET", API_COURSE_BY_IDS, params={"ids": course_id})
    rows = body if isinstance(body, list) else []
    if rows:
        it = rows[0] or {}
        # versionId / register 必须带出去：chapter-progress 少了 versionId 直接 422，
        # dry-run 体检与“只读回读进度”都靠这两个字段
        return {"bid": it.get("id") or course_id, "name": it.get("name") or "",
                "businessType": it.get("businessType"),
                "courseHour": it.get("courseHour"),
                "versionId": it.get("versionId") or "",
                "register": bool(it.get("register"))}
    return None


def course_logs(s, business_type: int = 0, days: int = 7) -> list[dict]:
    """学习记录：最近 N 天的课程/专题访问，含累计学习时长与完成状态。

    字段：beginTime / lastAccessTime（ms）、finishStatus、studyTotalTime（秒）、
    type（1=课程、6=专题类）、isRequired。时段接口按 recordCount 翻页。
    """
    import time as _t
    now = int(_t.time() * 1000)
    start = now - max(1, days) * 86400 * 1000
    out, page = [], 1
    while True:
        code, body = _req(s, "GET", API_COURSELOG, params={
            "businessType": business_type, "startTime": start, "endTime": now,
            "page": page, "pageSize": 100})
        if code != 200 or not isinstance(body, dict):
            raise RuntimeError(f"person-courselog 读取失败 HTTP {code}: {str(body)[:120]}")
        items = body.get("items") or []
        out.extend(items)
        total = int(body.get("recordCount") or 0)
        if not items or len(out) >= total:
            return out
        page += 1


def my_courses(s, business_type: int) -> list[dict]:
    """我的课程(business_type=0) / 专题(=2)：含不在「我的任务」里的自选课与专题内嵌子课程。

    finishStatus 2=复习(已完成) / 4=完成，两者都算学完。
    """
    out, seen, page, raw = [], set(), 1, 0
    while True:
        code, body = _req(s, "GET", API_PERSON_COURSE, params={
            "page": page, "pageSize": 500, "findStudy": 0, "businessType": business_type,
            "studyTimeOrder": "desc", "finishStatus": "", "isRequired": ""})
        if code != 200 or not isinstance(body, dict):
            raise RuntimeError(f"personCourse-list 读取失败 HTTP {code}: {str(body)[:120]}")
        items = body.get("items") or []
        raw += len(items)
        for it in items:
            cid = it.get("courseId")
            if not cid or cid in seen:
                continue
            seen.add(cid)
            out.append({"bid": cid,
                        "name": (it.get("courseInfo") or {}).get("name") or "",
                        "finish": it.get("finishStatus", 0),
                        "kind": "课程" if business_type == 0 else "专题"})
        if not items or raw >= (body.get("recordCount") or 0):
            break
        page += 1
    return out


def resolve_course(s, arg: str) -> tuple[str, str | None]:
    """把 ID / URL / 名称 解析成 (businessId, name)。

    名称匹配顺序：我的任务 → 我的课程/专题（**不在任务列表的课程也能按名字选中**）。
    ID 与页面 URL 无需匹配，直接可用（任意可学的课程 ID 都行）。
    """
    arg = (arg or "").strip()
    m = re.search(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|[0-9a-f]{32}", arg, re.I)
    if m:
        cid = m.group(0)
        det = course_detail(s, cid)          # 任意课程都能查到名称，不必在个人列表里
        if not det:
            say(f"[匹配] {cid} 查不到课程详情，按 id 直接尝试学习")
        elif cid not in {c["bid"] for bt in (0, 2) for c in my_courses(s, bt)}:
            say(f"[匹配] {det['name'][:40]} 不在「我的任务/我的课程」里，按平台课程直接学习")
        return cid, (det or {}).get("name")

    low = arg.lower()
    # ① 我的任务（未完成优先）
    tasks = [t for t in list_tasks(s) if low in (t.get("name") or "").lower()]
    if tasks:
        undone = [t for t in tasks if t.get("status") in TASK_UNDONE]
        pool = undone or tasks
        if len(pool) > 1:
            say(f"[匹配] 任务列表命中 {len(pool)} 个，取第一个：")
            for t in pool[:5]:
                say(f"        ({'未完成' if t.get('status') in TASK_UNDONE else '已完成'}) "
                    f"{t['name'][:40]}")
        return pool[0]["businessId"], pool[0].get("name")

    # ② 我的课程/专题（非任务列表也能学）
    cands = [c for bt in (0, 2) for c in my_courses(s, bt)
             if low in (c["name"] or "").lower()]
    if cands:
        undone = [c for c in cands if c["finish"] not in DONE_FINISH]
        pool = undone or cands
        if len(pool) > 1:
            say(f"[匹配] 我的课程命中 {len(pool)} 个，取第一个：")
            for c in pool[:5]:
                say(f"        ({c['kind']}|{'已学完' if c['finish'] in DONE_FINISH else '未学完'}) "
                    f"{c['name'][:40]}")
        say(f"[匹配] {pool[0]['name'][:40]} 不在「我的任务」里，按我的课程处理")
        return pool[0]["bid"], pool[0]["name"]

    raise SystemExit(
        f"任务列表和我的课程里都没有名称含 {arg!r} 的课程；"
        f"可以直接给 businessId 或课程页面 URL，先跑 --list 看看有什么")


# ---------------------------------------------------------------- 课程结构

def _flatten(chapters) -> list[dict]:
    out = []
    for ch in chapters if isinstance(chapters, list) else []:
        for sec in ch.get("courseChapterSections") or []:
            p = sec.get("progress") or {}
            out.append({"section_id": sec.get("referenceId"),
                        "resource_id": sec.get("resourceId"),
                        "name": sec.get("name") or sec.get("sectionName") or "",
                        "type": sec.get("sectionType"),
                        "finish": p.get("finishStatus", 0),
                        "studied": p.get("studyTotalTime") or 0})
    return out


def fetch_sections(s, course_id: str, det: dict) -> list[dict]:
    """只读拉小节（GET chapter-progress）。复核/回读用它，避免重复 POST register。

    失败要显式报错：若把 HTTP 500 / HTML 当成"空课程"，run_course 会返回 0/0
    并报成功，父小节还会误以为子课程已完成。
    """
    code, chs = _req(s, "GET", API_CHAPTERS, params={
        "courseId": course_id, "versionId": det.get("versionId", ""),
        "isRegister": det.get("register", False)})
    if code != 200 or not isinstance(chs, list):
        raise RuntimeError(f"chapter-progress 读取失败 HTTP {code}: {str(chs)[:120]}")
    return _flatten(chs)


def _library_sections(det: dict) -> list[dict]:
    """课程库详情（course-front/info）里的章节 → 统一个小节结构。"""
    secs = []
    for ch in det.get("courseChapters") or []:
        for sec in ch.get("courseChapterSections") or []:
            ft = (sec.get("fileType") or "").lower()
            secs.append({"section_id": sec.get("id"),
                         "resource_id": sec.get("attachmentId"),
                         "name": sec.get("name") or sec.get("sectionName") or "",
                         "type": FTYPE.get(ft, 0), "finish": 0, "studied": 0})
    return secs


def open_library_course(s, course_id: str) -> tuple[dict, list[dict]]:
    """课程库课程（未加入"我的课程"）：registerStudy 报名 + info/<id> 取章节。

    实测 2026-11-05（浏览器 HAR）：报名 body 需 type=1&isRequired=0；
    章节在 GET course-front/info/<id>?source=1&type=1 的 courseChapters 里，
    section.id 即 start-progress 用的 sectionId，attachmentId 即资源 id。
    """
    _req(s, "POST", API_COURSE_FRONT + "/registerStudy",
         data={"courseId": course_id, "type": 1, "isRequired": 0})
    _, info = _req(s, "GET", f"{API_COURSE_FRONT}/info/{course_id}",
                   params={"source": 1, "type": 1})
    det = dict(info or {})
    det["_library"] = True
    return det, _library_sections(det)


def open_course_readonly(s, course_id: str) -> tuple[dict, list[dict]]:
    """只读打开课程：不报名、不建学习记录（dry-run 体检专用）。

    register/registerStudy 会真的建学习记录（占配额），体检不能产生任何服务端写入。
    """
    det = course_detail(s, course_id) or {}
    for reg in (bool(det.get("register")), True):
        try:
            secs = fetch_sections(s, course_id, {**det, "register": reg})
        except RuntimeError:
            secs = []
        if secs:
            return {**det, "register": reg}, secs
    # 未加入「我的课程」的课平台不给 versionId，拿不到逐节进度：列章节清单并标记“进度未知”
    _, info = _req(s, "GET", f"{API_COURSE_FRONT}/info/{course_id}",
                   params={"source": 1, "type": 1})
    det = dict(info or {})
    det["_library"] = True
    det["_progress_unknown"] = True
    return det, _library_sections(det)


def open_course(s, course_id: str) -> tuple[dict, list[dict]]:
    """报名/取详情 + 章节树。register 会创建学习记录（幂等）。"""
    code, det = _req(s, "POST", API_REGISTER, data={"courseId": course_id})
    if code != 200 or not isinstance(det, dict) or not det:
        return open_library_course(s, course_id)      # 课程库课程（未加入我的课程）
    return det, fetch_sections(s, course_id, det)


def course_finish(s, course_id: str):
    """课程/专题层完成态（只读，不耗学时）。"""
    _, body = _req(s, "GET", API_COURSE_INFO, params={"ids": course_id})
    if isinstance(body, list) and body:
        return body[0].get("finishStatus")
    return None


def sync_sections(s, course_id: str, secs: list[dict]) -> None:
    """对齐前端：一次提交该课全部小节 resourceIds，刷新进度行。"""
    ids = ",".join(x["resource_id"] for x in secs if x.get("resource_id"))
    if ids:
        _req(s, "POST", API_SECTION, data={"courseId": course_id, "resourceIds": ids})


def progress_update(s, course_id: str) -> None:
    """对齐前端：上报后让平台重算该课进度（只刷新进度条，不改变完成态）。"""
    _req(s, "POST", API_PROGRESS_UPD, data={"encrypt": "false", "courseId": course_id})


# ---------------------------------------------------------------- 单小节上报

def _start(s, section_id: str, backdate: int, client_type: int = 1):
    """新建学习日志；createTime 回溯 backdate 秒，放宽 studyTime ≤ now−createTime 校验。

    client_type: 1="我的课程"路径；0=课程库课程（HAR 实测）。
    """
    ct = int(time.time() * 1000) - backdate * 1000
    code, body = _req(s, "GET", f"{API_START}/{section_id}",
                      params={"clientType": client_type, "createTime": ct})
    if code != 200 or not isinstance(body, dict) or not body.get("id"):
        return None, None
    return body["id"], body.get("remainingTime")


def _commit_video(s, log_id, study, loc, total):
    return _req(s, "POST", API_VIDEO, data={
        "encrypt": "false", "logId": log_id, "studyTime": int(study),
        "lessonLocation": int(loc), "resourceTotalTime": int(total), "flush": "false"})


def _commit_video_enc(s, log_id, study, loc, total):
    """课程库课程的 video-progress：全字段 AES-128-ECB + 随机 singleMark。

    实测（HAR 解密）：logId/lessonLocation/studyTime/resourceTotalTime/
    organizationId 均为 AES 密文，singleMark 是随机 UUID 的密文；无 encrypt 字段。
    """
    import uuid as _uuid
    from mooc_api import aes_encrypt as _enc
    return _req(s, "POST", API_VIDEO, data={
        "logId": _enc(log_id), "lessonLocation": _enc(loc), "studyTime": _enc(study),
        "resourceTotalTime": _enc(total), "organizationId": _enc(1),
        "singleMark": _enc(str(_uuid.uuid4()))})


def _commit_doc_enc(s, log_id, loc=None, single_mark=None):
    """课程库课程的 doc-progress：与 video 同款全字段 AES。

    逆向依据（app.js 的 commitDocProgress）：doc 与 video 共用 D.request 拦截器，
    参数里带 singleMark = 前端 state.uuid（课程学习会话标识），故字段规则一致，
    只是没有 studyTime/resourceTotalTime（doc 按时长累计而非单次上报）。
    """
    import uuid as _uuid
    from mooc_api import aes_encrypt as _enc
    d = {"logId": _enc(log_id), "organizationId": _enc(1),
         "singleMark": _enc(single_mark or str(_uuid.uuid4()))}
    if loc is not None:
        d["lessonLocation"] = _enc(loc)
    return _req(s, "POST", API_DOC, data=d)


def _commit_doc(s, log_id, loc=None):
    d = {"encrypt": "false", "logId": log_id}
    if loc is not None:
        d["lessonLocation"] = int(loc)
    return _req(s, "POST", API_DOC, data=d)


def settle_nested(s, parent_id: str, child_id: str, section_id: str, tries: int = 4) -> bool:
    """关联课程父小节：建父记录 → 心跳 → 回读确认（回读不到完成态就报失败）。"""
    _req(s, "POST", API_SECTION, data={"courseId": parent_id, "resourceIds": child_id})
    for _ in range(tries):
        log_id, _rem = _start(s, section_id, 3600)
        if log_id:
            _, body = _commit_doc(s, log_id)
            if isinstance(body, dict) and body.get("finishStatus") in DONE_FINISH:
                break
        time.sleep(random.uniform(2.5, 4.0))
    _, rows = _req(s, "POST", API_SECTION,
                   data={"courseId": parent_id, "resourceIds": child_id})
    if isinstance(rows, list) and rows:
        return rows[0].get("finishStatus") in DONE_FINISH
    return False


def study_section(s, sec: dict, *, chunk: int, dry_run: bool,
                  parent_id: str | None = None, course_id: str | None = None,
                  depth: int = 0, library: bool = False,
                  stats: dict | None = None,
                  budget: float | None = None) -> tuple[bool, str]:
    """把一个小节刷到完成态（finishStatus 2/4）。返回 (成功?, 说明)。

    stats 非空时写入本次实际提交的秒数（submitted），供上层做额度闸门。
    budget（秒）是本次运行剩余额度：小节没学完就达上限时停下并标 partial ——
    实测（2026-11-14 真实账号）只要不拦，单个 url 小节会一次刷掉 9407s（2.6h），
    把 --hours 0.03 这种小目标冲成 3.6 学时。
    """
    stats = stats if stats is not None else {}
    sid, stype = sec["section_id"], sec["type"]
    if stype in SKIP_TYPES:
        return False, f"SKIP|{TYPE_NAME.get(stype, stype)} 需真实作答，请本人完成"
    if sec["finish"] in DONE_FINISH:
        return True, "已完成，跳过"

    if stype == NESTED_TYPE:
        if depth >= MAX_DEPTH:
            return False, "嵌套过深，跳过"
        say(f"         ↳ 关联课程 {sec['resource_id']}")
        sub: dict = {}
        done, total = run_course(s, sec["resource_id"], chunk=chunk,
                                 dry_run=dry_run, depth=depth + 1, report=sub,
                                 budget=budget)
        # 子课程用掉的秒数也是本次运行的实账，要计进额度闸门（否则会白扣配额）
        stats["submitted"] = stats.get("submitted", 0) + float(sub.get("submitted") or 0)
        stats["sent"] = stats.get("sent", 0) + float(sub.get("sent") or 0)
        if dry_run:
            return False, f"[dry-run] 子课程 {done}/{total}"
        if done < total:
            return False, f"子课程未完成 {done}/{total}"
        ok = settle_nested(s, parent_id, sec["resource_id"], sid)
        return ok, ("子课程完成 + 父记录已判完成" if ok
                    else "子课程完成，父记录待平台复核（可稍后重跑）")

    if dry_run:
        # dry-run 不碰服务端：_start 会真的建学习记录并占用配额
        return False, f"[dry-run] 未开始 | {TYPE_NAME.get(stype, stype)}"

    total = None
    session_uuid = str(uuidlib.uuid4()) if library else None   # 贴近前端 state.uuid
    rounds = 0
    sent = 0.0          # 我们真正提交出去的秒数（额度闸门看它）
    accepted = 0.0      # 平台回报已收下的秒数（记账看它）
    prev_rem = None
    prev_step = 0
    stuck = 0
    max_rounds = 60
    while rounds < max_rounds:
        rounds += 1
        log_id, rem = _start(s, sid, chunk + random.randint(60, 300), 0 if library else 1)
        if log_id is None:
            return False, "start-progress 失败"
        if rem is None:                        # 字段缺失 ≠ 剩余 0 秒：不推断进度，也不据此报成
            prev_rem, prev_step = None, 0
            time.sleep(1)
            continue
        if prev_rem is not None and rem < prev_rem:
            # 上一轮真正被平台接受的秒数：据此校正单轮上限（服务端可能低于 --chunk）
            delta = prev_rem - rem
            accepted += delta
            if prev_step and delta < prev_step:
                chunk = max(30, delta)
                # chunk 变小了，剩余时长需要的轮数变多，上限跟着放大
                if total is not None:
                    max_rounds = max(max_rounds,
                                     min(900, int((total - accepted) / max(1, chunk)) + 10))
        if rem <= 0:                           # 服务端已无剩余：真完成与否由回读复核判定
            stats["submitted"] = stats.get("submitted", 0) + (accepted or sent)
            stats["sent"] = stats.get("sent", 0) + sent
            return True, f"remainingTime=0（共 {rounds} 轮 / {accepted or sent:.0f}s）"
        if prev_rem is not None and rem >= prev_rem and prev_step:
            stuck += 1
            if stuck >= 2:
                raise QuotaExhausted("剩余时长连续两轮未下降 —— 当日学时配额已满，请次日再跑")
        else:
            stuck = 0
        prev_rem = rem

        if total is None:
            total = rem + sec.get("studied", 0)
            # 轮数由剩余时长推导，别用固定 60 轮把长小节卡成假失败
            max_rounds = min(600, max(60, int(rem / max(1, chunk)) + 10))
        step = min(chunk, rem)
        if budget is not None:
            left = budget - sent
            if left <= 1:
                stats["submitted"] = stats.get("submitted", 0) + (accepted or sent)
                stats["sent"] = stats.get("sent", 0) + sent
                stats["partial"] = True
                return True, (f"已达本次学时额度（本小节未完成，已提交 {accepted or sent:.0f}s / 需 {total:.0f}s）"
                              if total else f"已达本次学时额度（已提交 {accepted or sent:.0f}s）")
            step = max(1, min(step, int(left)))      # 一次都不多提交
        sent += step
        loc = min(total, total - rem + step)
        if stype in MEDIA_TYPES:
            code, body = (_commit_video_enc(s, log_id, step, loc, total) if library
                          else _commit_video(s, log_id, step, loc, total))
        else:
            code, body = (_commit_doc_enc(s, log_id, loc, session_uuid) if library
                          else _commit_doc(s, log_id, loc))
        if code != 200:
            if isinstance(body, dict) and body.get("errorCode") == 40909:
                prev_rem, prev_step = None, 0   # 旧日志被拒，本轮无进展，别计入"卡住"
                time.sleep(1)
                continue
            stats["submitted"] = stats.get("submitted", 0) + accepted
            stats["sent"] = stats.get("sent", 0) + sent
            return False, f"上报失败 HTTP {code} {body}"
        prev_step = step
        if course_id:
            try:
                progress_update(s, course_id)   # 只刷新进度条，失败不该判本节失败
            except Exception:
                pass
        submitted_note = accepted + step if accepted else sent
        if isinstance(body, dict) and body.get("finishStatus") in DONE_FINISH:
            stats["submitted"] = stats.get("submitted", 0) + submitted_note
            stats["sent"] = stats.get("sent", 0) + sent
            return True, f"完成，共 {rounds} 轮 / {submitted_note:.0f}s"
        time.sleep(random.uniform(0.6, 1.6))
    stats["submitted"] = stats.get("submitted", 0) + (accepted or sent)
    stats["sent"] = stats.get("sent", 0) + sent
    return False, f"轮次用完仍未见完成（已提交 {accepted or sent:.0f}s）"


def run_course(s, course_id: str, *, chunk: int = 600, dry_run: bool = False,
               depth: int = 0, title: str | None = None,
               report: dict | None = None,
               budget: float | None = None) -> tuple[int, int]:
    """学完一门课；返回 (已完成小节数, 总小节数)。

    report 非空时写入 {ok, fail, skipped, submitted}：让上层能区分"学完了"与"有失败项"，
    并把本次被平台接受的秒数交给额度假门。budget（秒）用完后不再开新小节。
    不要把没学完的课程算成 ok=true。
    """
    det, secs = (open_course_readonly(s, course_id) if dry_run
                 else open_course(s, course_id))
    library = bool(det.get("_library"))
    say(f"\n===== {title or det.get('name')} =====")
    say(f"小节 {len(secs)} 个 | 已报名 {det.get('register')} | 单档 {chunk}s")
    todo = [x for x in secs if x["finish"] not in DONE_FINISH]
    say(f"待处理 {len(todo)} 个\n")

    ok = fail = skipped = 0
    partial = False
    touched = set()
    used_sec = 0.0      # 已提交出去的秒数（额度看它）
    got_sec = 0.0       # 平台回报收下的秒数（记账看它）
    for i, sec in enumerate(todo, 1):
        if budget is not None and used_sec >= budget:
            say(f"[额度] 本次目标已满（已提交 {used_sec:.0f}s），本课不再开新小节")
            break
        say(f"[{i}/{len(todo)}] ({TYPE_NAME.get(sec['type'], sec['type'])}) {sec['name'][:38]}")
        st: dict = {}
        try:
            good, msg = study_section(s, sec, chunk=chunk, dry_run=dry_run,
                                      parent_id=course_id, course_id=course_id,
                                      depth=depth, library=library, stats=st,
                                      budget=None if budget is None else budget - used_sec)
        except QuotaExhausted as exc:
            say(f"[配额] ⛔ {exc}")
            raise
        except AuthExpired:                            # token 失效：整门课停，别逐个撞 401
            raise
        except Exception as exc:                       # 单小节异常不终止整门课
            good, msg = False, f"异常 {type(exc).__name__}: {exc}"
        used_sec += float(st.get("sent") or st.get("submitted") or 0)
        got_sec += float(st.get("submitted") or 0)
        hit_budget = bool(st.get("partial"))
        is_skip = msg.startswith("SKIP|")
        mark = "OK" if good else ("SKIP" if (dry_run or is_skip) else "FAIL")
        if hit_budget:
            mark = "额度"                     # 不是失败，也不是真学完
        body = msg.removeprefix("SKIP|")
        say(f"         -> {mark} {body}")
        if is_skip:
            skipped += 1
        elif dry_run:
            pass                     # 体检不上报, 不能记成失败
        elif hit_budget:
            partial = True          # 没学完，但也不是错：额度到了
        else:
            ok += good
            fail += (not good)
        if good and not hit_budget:
            touched.add(sec["section_id"])
        if not dry_run:
            time.sleep(random.uniform(2.0, 5.0))
        if hit_budget:
            say("[额度] 已达本次学时上限，停在这节（下次续学）")
            break

    if dry_run:
        done = sum(1 for x in secs if x["finish"] in DONE_FINISH)
        if det.get("_progress_unknown"):
            say("\n[dry-run] 该课不在「我的课程」里：平台不返回逐节进度（chapter-progress 需 versionId），"
                "体检只列小节清单，完成度 0 不代表没学")
        say(f"\n[dry-run] 体检完成：待学 {len(todo)} 个（其中需本人完成 {skipped} 个），"
            f"未上报任何进度 | 小节完成度 {done}/{len(secs)}")
        if report is not None:
            report.update(ok=ok, fail=fail, skipped=skipped, done=done, total=len(secs),
                          submitted=got_sec, sent=used_sec, partial=partial)
        return done, len(secs)

    # 回读复核：父小节 settle 后可能被平台复核打回 0，补一次 settle
    sync_sections(s, course_id, secs)
    secs2 = fetch_sections(s, course_id, det)      # 回读只 GET，不再重复 register
    back = [x for x in secs2 if x["section_id"] in touched and x["finish"] not in DONE_FINISH]
    if back:
        nested = [x for x in back if x["type"] == NESTED_TYPE]
        if len(nested) != len(back):
            # 平台结算是异步的：先等一轮再读，避免把"还没汇总"当成"被打回"而重复上报扣学时
            say(f"\n[复核] {len(back) - len(nested)} 个已上报小节尚未结算，"
                f"等待 {SETTLE_WAIT}s 后回读")
            time.sleep(SETTLE_WAIT)
            secs2 = fetch_sections(s, course_id, det)
            back = [x for x in secs2
                    if x["section_id"] in touched and x["finish"] not in DONE_FINISH]
            nested = [x for x in back if x["type"] == NESTED_TYPE]
        if nested:
            say(f"\n[修复] {len(nested)} 个本次已处理的关联课程回退到未完成，重新 settle")
            for x in nested:
                good = settle_nested(s, course_id, x["resource_id"], x["section_id"])
                say(f"         {'✅' if good else '⏳'} {x['name'][:30]}")
        pending = [x for x in back if x["type"] != NESTED_TYPE]
        if pending:
            say(f"[复核] {len(pending)} 个小节已上报但平台未汇总（服务端异步结算，别重跑）："
                + "、".join(x["name"][:16] for x in pending[:5]))
        secs2 = fetch_sections(s, course_id, det)

    done = sum(1 for x in secs2 if x["finish"] in DONE_FINISH)
    skip_note = f" / 需本人完成 {skipped}" if skipped else ""
    part_note = " / 额度到点提前停" if partial else ""
    say(f"\n结果: 成功 {ok} / 失败 {fail}{skip_note}{part_note} | 小节完成度 {done}/{len(secs2)}")
    if report is not None:
        report.update(ok=ok, fail=fail, skipped=skipped, done=done, total=len(secs2),
                      submitted=got_sec, sent=used_sec, partial=partial)
    return done, len(secs2)


def wait_finish(s, course_id: str, timeout: int,
                deadline: float | None = None) -> bool:
    """只读轮询课程/专题层完成态（服务端异步结算，实测 2–18 分钟）。

    deadline（time.time() 口径）在场时总等待不超过它，避免多个目标各自等满 timeout。
    """
    t0 = time.time()
    limit = float(timeout)
    if deadline is not None:
        limit = max(1.0, min(limit, deadline - t0))
    while True:
        try:
            if course_finish(s, course_id) in DONE_FINISH:
                say(f"[复核] 平台已完成汇总（等待 {int(time.time() - t0)}s）")
                return True
        except Exception as exc:
            say(f"[复核] 查询失败 {type(exc).__name__}: {exc}")
        if time.time() - t0 >= limit:
            say(f"[复核] 平台尚未汇总（已等 {int(time.time() - t0)}s）；"
                "服务端异步结算实测需 2–18 分钟，稍后重跑可复查，不必重新学")
            return False
        time.sleep(min(30, max(1, limit - (time.time() - t0))))


# ---------------------------------------------------------------- 目标模式

def _today_used_path():
    """本地当日用量账本。data/ 已在 .gitignore 里。"""
    import os
    from pathlib import Path
    home = os.environ.get("TOBACCO_HOME")
    base = Path(home) if home else Path(__file__).resolve().parent.parent / "data"
    return base / "today_used.json"


def _today_ledger() -> dict:
    import json
    try:
        return json.loads(_today_used_path().read_text(encoding="utf-8")) or {}
    except Exception:
        return {}


def platform_today_hours(s) -> float | None:
    """平台侧今天的学时合计（person-courselog 的 studyTotalTime）。

    实测（2026-11-14，真实账号）：学完 2340s、hourSelf 从 277.2 升到 278.1，
    但新落的记录 studyTotalTime 仍是 0（只有播放器正常停止的记录才带时长）。
    所以这里只在“确实读到非零值”时返回数字，否则返回 None 表示“平台未提供”，
    让上层退回本地账本，而不是把 0 当成“今天什么都没学”。
    """
    import datetime
    import time as _t
    midnight = int(datetime.datetime.combine(cn_today(),
                                            datetime.time(0), tzinfo=CN_TZ).timestamp() * 1000)
    now = int(_t.time() * 1000)
    total, seen = 0.0, set()
    for bt in (0, 2):
        code, body = _req(s, "GET", API_COURSELOG, params={
            "businessType": bt, "startTime": midnight, "endTime": now,
            "page": 1, "pageSize": 200})
        for r in (body or {}).get("items") or []:
            if r.get("id") in seen:
                continue                      # businessType 0/2 重叠
            seen.add(r.get("id"))
            total += float(r.get("studyTotalTime") or 0)
    return round(total / 3600, 2) if total > 0 else None


def today_used(hour_self: float | None = None) -> float:
    """今天已学（学时）。优先用「平台结算口径」= 当前 hourSelf − 今日基准。

    旧账本只有 used（工具自报累计），保留兼容；新账本记录 base/last，
    没传 hour_self 时用最近一次落账的 last 估算。
    """
    import datetime
    obj = _today_ledger()
    if obj.get("date") != cn_today().isoformat():
        return 0.0
    if "base" in obj and "last" in obj:
        last = float(obj["last"] if hour_self is None else hour_self)
        used = max(0.0, round(last - float(obj["base"]), 2))
        # extra = 本次运行本地已确认上报、平台尚未结算的部分；取 max 避免重复计
        return max(used, round(float(obj.get("extra") or 0), 2))
    return max(0.0, float(obj.get("used") or 0),
               round(float(obj.get("extra") or 0), 2))


def record_today_hours(hour_self: float, platform_today: float = 0.0,
                       session_base: float | None = None) -> None:
    """用平台 hourSelf 落账：当天首次以 (现值 − 平台今日已记) 为基准，之后只更新现值。

    比「工具自报增量」准：平台结算延迟 2–18 分钟，自报会重复计或漏计。
    """
    import datetime
    import json
    if hour_self is None or float(hour_self) <= 0:
        return
    today = cn_today().isoformat()
    obj = _today_ledger()
    legacy = (float(obj.get("used") or 0)
              if obj.get("date") == today and "base" not in obj else 0.0)
    extra = round(float(obj.get("extra") or 0), 2) if obj.get("date") == today else 0.0
    if obj.get("date") != today or "base" not in obj:
        plat = max(0.0, float(platform_today or 0))
        if plat > 0:                            # 平台已记今日学时 → 起点可由它反推，比"本次读数"准
            base = round(float(hour_self) - plat - legacy, 2)
        elif session_base is not None:          # 平台今日为 0：本次读数就是今日起点
            base = round(float(session_base) - legacy, 2)
        else:
            base = round(float(hour_self) - legacy, 2)
        # 不变量：「今日已学」不能小于本地已提交，否则额度会被算松
        base = min(base, round(float(hour_self) - extra, 2))
        obj = {"date": today, "base": base,
               "last": round(float(hour_self), 2), "extra": extra}
    else:
        obj["last"] = round(float(hour_self), 2)
        if extra:
            obj["extra"] = extra
    try:
        from tobacco import save_json
        save_json(_today_used_path(), obj)      # tmp + replace：半写损坏会让额度重新给满
    except Exception as exc:                    # 记账失败不该影响学习
        say(f"[今日] 本地记账失败（不影响已学学时）：{exc}")


def record_today_local(seconds: float | None) -> None:
    """本地已确认上报的秒数：平台 hourSelf 结算滞后 2–18 分钟时，用它托底今日已学。

    与 hourSelf 口径取较大值（max 而非相加），平台补记后不会重复计。
    """
    import datetime
    if not seconds or float(seconds) <= 0:
        return
    hours = round(float(seconds) / 3600.0, 2)
    today = cn_today().isoformat()
    obj = _today_ledger()
    if obj.get("date") != today:
        # 只写 extra：base/last 要等拿到真实 hourSelf 才能定（写 0 会把累计学时当成今日已学）
        obj = {"date": today}
    obj["extra"] = max(round(float(obj.get("extra") or 0), 2), hours)
    try:
        from tobacco import save_json
        save_json(_today_used_path(), obj)
    except Exception as exc:
        say(f"[今日] 本地记账失败（不影响已学学时）：{exc}")


def record_today_used(delta: float | None) -> None:
    """兼容旧调用：旧账本（只有 used）时按增量累加；新账本已被 hourSelf 口径覆盖，忽略。"""
    import datetime
    import json
    if not delta or delta <= 0:
        return
    obj = _today_ledger()
    if "base" in obj:                           # 新口径自动反映，无需再累加
        return
    used = round(today_used() + float(delta), 2)
    try:
        p = _today_used_path()
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps({"date": cn_today().isoformat(), "used": used},
                                ensure_ascii=False), encoding="utf-8")
    except OSError as exc:
        say(f"[今日] 本地记账失败（不影响已学学时）：{exc}")


def _today_capacity() -> tuple[float, dict]:
    """今日可学学时容量：读本地工作档位（tobacco.py 的 profile.json），按工作日/周末取值。"""
    try:
        from tobacco import load_profile
        prof = load_profile()
    except Exception:                       # 没配档位就与 tobacco.py 的 office 档保持一致
        try:
            from tobacco import DEFAULT_PROFILE as _DP, WORK_PROFILES as _WP
            prof = dict(_WP[_DP])
        except Exception:
            prof = {"label": "默认", "weekday_hours": 1.0, "weekend_hours": 3.0}
    import datetime
    weekend = cn_today().weekday() >= 5
    cap = float(prof.get("weekend_hours" if weekend else "weekday_hours") or 0)
    return cap, prof


def net_hours(s) -> tuple[float, float]:
    """网络自学 (已完成, 要求) 学时。"""
    g = fetch_summary(s)["网络自学"]
    return g["已完成"], g["要求"]


def show_list(s) -> None:
    got, need = net_hours(s)
    say(f"网络自学 {got:.2f} / 要求 {need:.2f} 学时 | 缺口 {max(0.0, need - got):.2f}")
    items = undone_tasks(s)
    say(f"\n可学目标（我的任务）{len(items)} 个（未完成/未开始）：")
    now_ms = time.time() * 1000
    for t in sorted(items, key=lambda x: x.get("endTime") or 0):
        start = t.get("startTime") or 0
        state = "未开始" if start > now_ms else "未完成"
        say(f"  [{TASK_TYPE.get(t['businessType'], t['businessType'])}|{state}] "
            f"{(t.get('name') or '')[:44]:46s} {t['businessId']}")
    if not items:
        say("  （我的任务里没有待学项）")
    # 非任务列表的课程/专题（自选课、专题内嵌子课程）—— 用 --course <名称|ID|URL> 直接学
    task_ids = {t["businessId"] for t in list_tasks(s)}
    extra = [c for bt in (0, 2) for c in my_courses(s, bt)
             if c["bid"] not in task_ids and c["finish"] not in DONE_FINISH]
    if extra:
        say(f"\n其他可学课程/专题（不在我的任务里）{len(extra)} 个：")
        for c in extra[:40]:
            say(f"  [{c['kind']}|未学完] {(c['name'] or '')[:44]:46s} {c['bid']}")
        if len(extra) > 40:
            say(f"  …还有 {len(extra) - 40} 个")


def _hour_candidates(s) -> list[tuple[str, str | None]]:
    """学时模式的候选课：我的任务优先，再补「我的课程/专题」里未学完的（非任务课程也能用来补学时）。"""
    tasks = [(t["businessId"], t.get("name")) for t in undone_tasks(s)]
    ids = {cid for cid, _ in tasks}
    extra, seen = [], set(ids)
    for bt in (0, 2):
        for c in my_courses(s, bt):
            if c["bid"] in seen or c["finish"] in DONE_FINISH:
                continue
            seen.add(c["bid"])
            extra.append((c["bid"], c["name"]))
    return tasks + extra


def run_targets(s, targets: list[tuple[str, str | None]], *, chunk: int, dry_run: bool,
                wait: int) -> dict:
    """依次学完给定目标，并汇总。"""
    stat = {"courses": 0, "done": 0, "total": 0, "failed": 0, "confirmed": 0}
    for i, (cid, name) in enumerate(targets, 1):
        say(f"\n########## 目标 [{i}/{len(targets)}] {(name or cid)[:40]} ##########")
        rep: dict = {}
        try:
            done, total = run_course(s, cid, chunk=chunk, dry_run=dry_run,
                                     title=name, report=rep)
        except QuotaExhausted:
            stat["failed"] += 1
            stat["quota"] = True               # 熔断要上报成退出码 3，不能降级成普通失败
            say("[目标] ⛔ 当日配额已满，停止剩余目标")
            break
        except RuntimeError as exc:              # 读取/接口失败
            stat["failed"] += 1
            say(f"[目标] ⚠️ 读取失败：{exc}")
            continue
        stat["courses"] += 1
        stat["done"] += done
        stat["total"] += total
        if rep.get("fail"):
            stat["failed"] += 1          # 有失败小节/子课程没学完, 不能报 ok
        if not dry_run and wait:
            stat["confirmed"] += bool(wait_finish(s, cid, wait))
    return stat


def _main(argv=None) -> int:
    p = argparse.ArgumentParser(
        description="按目标自动完成学习任务（仅限本人账号，须本人显式要求）")
    g = p.add_mutually_exclusive_group()
    g.add_argument("--course", metavar="目标", action="append",
                   help="学完指定专题/课程：名称(模糊)、businessId 或页面 URL，可重复")
    g.add_argument("--hours", type=float, metavar="N",
                   help="刷够 N 学时（按 网络自学 缺口自动选课；--hours 0 表示补齐到要求线）")
    g.add_argument("--todo", action="store_true", help="学完全部 未完成/未开始 的课程与专题")
    g.add_argument("--today", action="store_true",
                   help="只学今天该学的量（按本地工作档位容量与学时缺口取小）")
    g.add_argument("--list", action="store_true", help="只列出可学目标与学时缺口")
    p.add_argument("--search", metavar="关键词",
                   help="搜索平台课程库（含未加入任务的课程/专题）；配合 --course <id> 可直接学习")
    p.add_argument("--logs", metavar="天数", type=int, nargs="?", const=7, default=None,
                   help="学习记录：最近 N 天学过/在学的课程与专题（默认 7 天）")
    p.add_argument("--dry-run", action="store_true", help="只体检：看选课与剩余时长，不上报")
    p.add_argument("--chunk", type=int, default=600, help="单轮上报秒数（默认 600）")
    p.add_argument("--wait-sync", type=int, default=0, metavar="秒",
                   help="学完后只读等待专题层汇总的秒数（0=不等，实测需 2–18 分钟）")
    p.add_argument("--json", action="store_true", help="结束时额外输出 JSON 摘要")
    a = p.parse_args(argv)

    try:
        token, meta = load_session()
    except SystemExit as exc:                  # 没有会话/会话过期：不要用栈吓用户
        say(f"[会话] ⛔ {exc}")
        say("[会话] 先登录：mooc_api.py qr wechat（扫码）或 mooc_tasks.py login-pwd（账密）")
        _result("auth", failed=1, error="no_session")
        return 2
    s = api_session(token)
    # 端归属：账密 app-login 属于 APP 端会话，扫码属于网页端会话；平台按端单会话
    src = meta.get("token_source") or meta.get("source") or "unknown"
    side = {"app-login": "APP 端（账密登录）",
            "qr-wechat": "网页端（微信扫码）",
            "qr-app": "网页端（APP 扫码）"}.get(src, "未知")
    say(f"[会话] token 有效至 {meta.get('expires_at') or '未知'}｜来源 {side}")
    say("[会话] 平台按端单会话（enableUnique=1）：学习期间别在同一端 App/网页里同时操作，"
        "否则会互相顶下线")

    if a.logs is not None:
        merged = {}
        for r in course_logs(s, 0, a.logs) + course_logs(s, 2, a.logs):
            merged[r.get("id")] = r          # businessType 0/2 会重叠，按记录 id 去重
        rows = sorted(merged.values(),
                      key=lambda r: r.get("lastAccessTime") or 0, reverse=True)
        say(f"[记录] 最近 {a.logs} 天：{len(rows)} 条")
        for r in rows[:40]:
            import datetime as _dt
            la = r.get("lastAccessTime")
            ts = _dt.datetime.fromtimestamp(la / 1000, tz=CN_TZ).strftime("%m-%d %H:%M") if la else "  —  "
            name = (r.get("courseInfo") or {}).get("name") or r.get("courseId") or ""
            fs = r.get("finishStatus")
            state = ("已学完" if fs in DONE_FINISH
                     else {0: "未开始", 1: "学习中"}.get(fs, str(fs)))
            t = (r.get("studyTotalTime") or 0) / 3600
            say(f"  {ts}  {state:4s}  {t:5.2f}h  {name[:40]}")
        _result("logs", count=len(rows))
        return 0
    if a.search:
        rows = search_courses(s, a.search)
        say(f"[搜索] 「{a.search}」命中 {len(rows)} 条（平台课程库，含未加入任务的）")
        for r in rows[:20]:
            say(f"  [{r['kind']}] {r['name'][:44]:46s} {r['courseHour']:>5.1f} 学时  {r['id']}")
        if not (a.course or a.todo or a.today or a.hours is not None):
            _result("search", found=len(rows))
            return 0
    if a.list or not (a.course or a.hours is not None or a.todo or a.today):
        show_list(s)
        _result("list", undone=len(undone_tasks(s)))
        return 0

    h0, need = None, 0.0
    if not a.list:
        try:
            h0, need = net_hours(s)          # 入口读一次，末尾用它算增量并记账
        except AuthExpired:                  # token 失效不是「读取失败」，要穿透到退出码 2
            raise
        except Exception as exc:
            if a.hours is not None or a.today:
                say(f"[错误] 读取学时总览失败，无法算出目标：{exc}")
                _result("today" if a.today else "hours", failed=1)
                return 1
            say(f"[学时] 总览读取失败，本次不记账：{exc}")
    if h0 is not None and not a.dry_run:
        # 今日基准：学前的 hourSelf − 平台今日已记。开跑前落一次账，中途 401 也不丢基准
        plat0 = None
        try:
            plat0 = platform_today_hours(s)
            if plat0 is None:
                say("[学时] 平台未提供当日学时（studyTotalTime 恒为 0），额度按本地账本估算")
        except AuthExpired:                  # 401 不是「读取失败」，要穿透到退出码 2
            raise
        except Exception as exc:
            # 拿不到平台当日已记：基准会偏高（额度偏松），必须让用户看见
            say(f"[学时] 平台当日学时读取失败（{exc}），额度按本地记录估算")
        record_today_hours(h0, plat0, session_base=h0)
    if a.course:
        try:
            targets = [resolve_course(s, x) for x in a.course]
        except SystemExit as exc:            # 名称没匹配到：给出 RESULT 行，不要裸退出
            say(f"[目标] ⛔ {exc}")
            _result("course", failed=1, error="course_not_found")
            return 2
        mode = "course"
    elif a.todo:
        targets = [(t["businessId"], t.get("name")) for t in undone_tasks(s)]
        mode = "todo"
    else:
        got = h0 if h0 is not None else 0.0
        mode = "today" if a.today else "hours"
        if a.today:
            cap, prof = _today_capacity()
            gap = max(0.0, need - got)
            say(f"[今日] 档位「{prof.get('label') or '默认'}」｜今日容量 {cap:.2f} 学时"
                f"｜网络自学 {got:.2f}/{need:.2f}，缺口 {gap:.2f}")
            used = today_used(h0 if h0 is not None else None)
            left = max(0.0, cap - used)
            quota = min(left, gap)
            say(f"[今日] 今天已学 {used:.2f} 学时，剩余额度 {left:.2f}")
            if quota <= 0:
                say("[今日] ✅ 今天不用再学（容量已用满或学时已达标）")
                _result("today", hours_gained=0)
                return 0
            say(f"[今日] 今天的目标 {quota:.2f} 学时，学完即停（不必一天刷完）")
            h0, deficit = got, quota
        else:
            goal = a.hours or 0
            deficit = max(0.0, need - got) if goal <= 0 else goal
            say(f"[学时] 网络自学 {got:.2f}/{need:.2f}，目标再刷 {deficit:.2f} 学时")
        if deficit <= 0:
            say("[学时] ✅ 已达要求线，无需再刷")
            _result(mode, hours_gained=0)
            return 0
        targets = _hour_candidates(s)

    if not targets:
        say("[目标] 没有可学任务")
        if mode in ("hours", "today"):
            say("[目标] 有学时缺口，但没有可学的课程/专题（都被跳过、已完成或已过期）")
            _result(mode, failed=1)
            return 1
        _result(mode)
        return 0

    say(f"[目标] {len(targets)} 个，模式 {mode}{'（dry-run，不上报）' if a.dry_run else ''}")
    # h0 由学时模式在选课前赋值；其它模式为 None
    stat = {"courses": 0, "done": 0, "total": 0, "failed": 0, "confirmed": 0}

    gained = None
    local_sec = 0.0
    unmet = False
    ran: list[str] = []
    last_mark = h0                      # 已落账到的学时读数，逐门推进
    if mode in ("hours", "today"):
        # 学时/今日目标：本地已提交秒数当硬闸门 —— 平台 hourSelf 结算滞后 2–18 分钟，
        # 只看它会让循环把候选课全部学完（超额数倍），它只做事后校正。
        budget = deficit * 3600.0
        for i, (cid, name) in enumerate(targets, 1):
            if budget - local_sec <= 1:
                break
            say(f"\n########## 学时目标 [{i}/{len(targets)}] {(name or cid)[:40]} ##########")
            rep = {}
            try:
                done, total = run_course(s, cid, chunk=a.chunk, dry_run=a.dry_run,
                                         title=name, report=rep,
                                         budget=max(1.0, budget - local_sec))
            except QuotaExhausted:
                stat["failed"] += 1
                stat["quota"] = True           # 熔断要上报成退出码 3，不能降级成普通失败
                say("[学时] ⛔ 当日配额已满，停止")
                break
            except RuntimeError as exc:
                stat["failed"] += 1
                say(f"[学时] ⚠️ 读取失败：{exc}")
                continue
            ran.append(cid)
            stat["courses"] += 1
            stat["done"] += done
            stat["total"] += total
            if rep.get("fail"):
                stat["failed"] += 1
            if rep.get("partial"):
                stat["partial"] = True         # 停在半节：进 --json 供助手判断「别当失败重跑」
            local_sec += float(rep.get("sent") or rep.get("submitted") or 0)
            # 闸门口径与课内一致看 sent（提交出去的秒数）：上报失败时 submitted 会漏计，
            # 导致闸门偏松、继续开下一门课超额提交
            if a.dry_run:
                say("[dry-run] 只体检首个目标：体检不累计已提交秒数，继续枚举会把全部候选课都打开一遍")
                break
            record_today_local(local_sec)
            now = net_hours(s)[0]
            if now is not None and h0 is not None:
                gained = round(now - h0, 2)
            if last_mark is not None and now is not None:
                record_today_hours(now)          # 平台结算口径，每门课刷新一次
                last_mark = now
            say(f"[学时] 已累计 本地 {local_sec / 3600:.2f}h / "
                f"平台 {'—' if gained is None else f'+{gained:.2f}h'}，目标 {deficit:.2f}h")
            if rep.get("partial"):
                say("[学时] 额度已到点，停在半节上（下次续学，不要当失败重跑）")
                break
            if local_sec / 3600.0 >= deficit or (gained is not None and gained >= deficit):
                say(f"[学时] 🎉 已达成：本地已提交 {local_sec / 3600:.2f}h"
                    f" / 平台 +{gained if gained is not None else 0:.2f}h")
                break
        if not a.dry_run and a.wait_sync and ran:
            deadline = time.time() + a.wait_sync
            for cid in ran:
                left = deadline - time.time()
                if left <= 1:
                    break
                if wait_finish(s, cid, int(left)):
                    stat["confirmed"] += 1
        if not a.dry_run and gained is not None and not stat.get("quota"):
            if local_sec / 3600.0 < deficit and gained < deficit:
                # 目标没达成不等于“出错”：已经提交的秒数在等平台结算。
                # 单独用一个状态位，避免与“配额熔断”叠加把失败数算成 2。
                unmet = True
                say(f"[学时] ⚠️ 目标未达成：本地 +{local_sec / 3600:.2f}h / "
                    f"平台 +{gained:.2f}h，目标 {deficit:.2f}h（候选课已用完，或都被跳过）")
            elif gained < deficit:
                say(f"[学时] ⏳ 已提交 {local_sec / 3600:.2f}h，平台结算滞后（2–18 分钟），"
                    "稍后复查即可，不要重跑（会白扣配额）")
    else:
        stat = run_targets(s, targets, chunk=a.chunk, dry_run=a.dry_run, wait=a.wait_sync)

    try:
        h_now = net_hours(s)[0]
    except Exception as exc:
        h_now = h0                             # 回读失败：按本次开始时的读数记账
        say(f"[学时] 收尾回读失败（{exc}），本次按已知读数记账")
    gained = round(h_now - h0, 2) if (h0 is not None and h_now is not None) else None
    if not a.dry_run and h_now is not None:
        record_today_hours(h_now)                 # 基准已在开跑前落账，这里只更新现值
    say("\n========== 汇总 ==========")
    say(f"目标 {stat['courses']}/{len(targets)} | 小节 {stat['done']}/{stat['total']} | "
        f"失败 {stat['failed']}" + (f" | 学时 +{gained}" if gained is not None else ""))
    if stat["failed"]:
        say("（⚠️ 有失败项；⏳ 表示已学完但平台尚未汇总，不要重跑，会白扣配额）")
    elif unmet:
        say("（⏳ 目标未达成，但本次已提交的学时可能仍在结算，先别重跑）")
    _result(mode, courses=stat["courses"], done=stat["done"], total=stat["total"],
            failed=stat["failed"], hours_gained=gained,
            **({"error": "quota_exhausted"} if stat.get("quota")
               else {"error": "target_unmet"} if unmet else {}))
    if a.json:
        print(json.dumps({"mode": mode, "courses": stat["courses"], "done": stat["done"],
                          "total": stat["total"], "failed": stat["failed"],
                          "hours_gained": gained, "unmet": unmet,
                          "partial": bool(stat.get("partial")),
                          "quota": bool(stat.get("quota"))}, ensure_ascii=False))
    if stat.get("quota"):
        return 3                             # SKILL.md 承诺的退出码：助手据此次日再跑，而不是当失败重跑
    return 0 if not (stat["failed"] or unmet) else 1


if __name__ == "__main__":                     # pragma: no cover
    try:
        sys.exit(_main())
    except AuthExpired as exc:
        say(f"[会话] ⛔ {exc}")
        _result("auth", failed=1, error="auth_expired")
        sys.exit(2)
    except QuotaExhausted as exc:
        say(f"[配额] ⛔ {exc}")
        _result("quota", failed=1, error="quota_exhausted")
        sys.exit(3)
