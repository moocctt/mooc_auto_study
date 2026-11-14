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
import json
import random
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from mooc_tasks import API, api_session, fetch_summary, load_session  # noqa: E402

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

API_TASKS = "/human/task"
# 我的课程/专题（含不在"我的任务"里的自选课、专题内嵌子课程）
API_PERSON_COURSE = "/course-study/course-study-progress/personCourse-list"
# 按 id 取任意课程详情（不需要该课在"我的任务/我的课程"里）
API_COURSE_BY_IDS = "/course-study/course-info/front/find-by-ids"
API_REGISTER = "/course-study/course-front/register"
API_CHAPTERS = "/course-study/subject/chapter-progress"
API_START = "/course-study/course-front/start-progress"
API_VIDEO = "/course-study/course-front/video-progress"
API_DOC = "/course-study/course-front/doc-progress"
API_SECTION = "/course-study/course-front/course-section-progress"
API_COURSE_INFO = "/course-study/course-front/course-info-progress"
API_PROGRESS_UPD = "/course-study/course-front/course-progress-update"


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
        raise SystemExit("401：token 失效或已过期，请先重新登录（mooc_tasks.py login-password）")
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


def course_detail(s, course_id: str) -> dict | None:
    """按 id 取课程详情（名称/学时/类型）。平台内任意课程都可查，不要求已加入个人列表。"""
    _, body = _req(s, "GET", API_COURSE_BY_IDS, params={"ids": course_id})
    rows = body if isinstance(body, list) else []
    if rows:
        it = rows[0] or {}
        return {"bid": it.get("id") or course_id, "name": it.get("name") or "",
                "businessType": it.get("businessType"),
                "courseHour": it.get("courseHour")}
    return None


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


def open_course(s, course_id: str) -> tuple[dict, list[dict]]:
    """报名/取详情 + 章节树。register 会创建学习记录（幂等）。"""
    _, det = _req(s, "POST", API_REGISTER, data={"courseId": course_id})
    det = det or {}
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

def _start(s, section_id: str, backdate: int):
    """新建学习日志；createTime 回溯 backdate 秒，放宽 studyTime ≤ now−createTime 校验。"""
    ct = int(time.time() * 1000) - backdate * 1000
    code, body = _req(s, "GET", f"{API_START}/{section_id}",
                      params={"clientType": 1, "createTime": ct})
    if code != 200 or not isinstance(body, dict) or not body.get("id"):
        return None, None
    return body["id"], body.get("remainingTime")


def _commit_video(s, log_id, study, loc, total):
    return _req(s, "POST", API_VIDEO, data={
        "encrypt": "false", "logId": log_id, "studyTime": int(study),
        "lessonLocation": int(loc), "resourceTotalTime": int(total), "flush": "false"})


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
                  depth: int = 0) -> tuple[bool, str]:
    """把一个小节刷到完成态（finishStatus 2/4）。返回 (成功?, 说明)。"""
    sid, stype = sec["section_id"], sec["type"]
    if stype in SKIP_TYPES:
        return False, f"SKIP|{TYPE_NAME.get(stype, stype)} 需真实作答，请本人完成"
    if sec["finish"] in DONE_FINISH:
        return True, "已完成，跳过"

    if stype == NESTED_TYPE:
        if depth >= MAX_DEPTH:
            return False, "嵌套过深，跳过"
        say(f"         ↳ 关联课程 {sec['resource_id']}")
        done, total = run_course(s, sec["resource_id"], chunk=chunk,
                                 dry_run=dry_run, depth=depth + 1)
        if dry_run:
            return False, f"[dry-run] 子课程 {done}/{total}"
        if done < total:
            return False, f"子课程未完成 {done}/{total}"
        ok = settle_nested(s, parent_id, sec["resource_id"], sid)
        return ok, ("子课程完成 + 父记录已判完成" if ok
                    else "子课程完成，父记录待平台复核（可稍后重跑）")

    if dry_run:
        _, rem = _start(s, sid, 3600)
        return False, f"[dry-run] 剩余 {rem}s | {TYPE_NAME.get(stype, stype)}"

    total = None
    rounds = submitted = 0
    prev_rem = None
    stuck = 0
    for _ in range(60):
        rounds += 1
        log_id, rem = _start(s, sid, chunk + random.randint(60, 300))
        if log_id is None:
            return False, "start-progress 失败"
        rem = rem or 0
        if rem <= 0:
            break
        if prev_rem is not None and rem >= prev_rem:
            stuck += 1
            if stuck >= 2:
                raise QuotaExhausted("剩余时长连续两轮未下降 —— 当日学时配额已满，请次日再跑")
        else:
            stuck = 0
        prev_rem = rem

        if total is None:
            total = rem + sec["studied"]
        step = min(chunk, rem)
        loc = min(total, total - rem + step)
        if stype in MEDIA_TYPES:
            code, body = _commit_video(s, log_id, step, loc, total)
        else:
            code, body = _commit_doc(s, log_id, loc)
        if code != 200:
            if isinstance(body, dict) and body.get("errorCode") == 40909:
                time.sleep(1)
                continue
            return False, f"上报失败 HTTP {code} {body}"
        submitted += step
        if course_id:
            progress_update(s, course_id)
        if isinstance(body, dict) and body.get("finishStatus") in DONE_FINISH:
            return True, f"完成，共 {rounds} 轮 / {submitted}s"
        time.sleep(random.uniform(0.6, 1.6))
    return False, f"轮次用完仍未见完成（已提交 {submitted}s）"


def run_course(s, course_id: str, *, chunk: int = 600, dry_run: bool = False,
               depth: int = 0, title: str | None = None,
               report: dict | None = None) -> tuple[int, int]:
    """学完一门课；返回 (已完成小节数, 总小节数)。

    report 非空时写入 {ok, fail, skipped}：让上层能区分"学完了"与"有失败项"，
    不要把没学完的课程算成 ok=true。
    """
    det, secs = open_course(s, course_id)
    say(f"\n===== {title or det.get('name')} =====")
    say(f"小节 {len(secs)} 个 | 已报名 {det.get('register')} | 单档 {chunk}s")
    todo = [x for x in secs if x["finish"] not in DONE_FINISH]
    say(f"待处理 {len(todo)} 个\n")

    ok = fail = skipped = 0
    touched = set()
    for i, sec in enumerate(todo, 1):
        say(f"[{i}/{len(todo)}] ({TYPE_NAME.get(sec['type'], sec['type'])}) {sec['name'][:38]}")
        try:
            good, msg = study_section(s, sec, chunk=chunk, dry_run=dry_run,
                                      parent_id=course_id, course_id=course_id, depth=depth)
        except QuotaExhausted as exc:
            say(f"[配额] ⛔ {exc}")
            raise
        except Exception as exc:                       # 单小节异常不终止整门课
            good, msg = False, f"异常 {type(exc).__name__}: {exc}"
        is_skip = msg.startswith("SKIP|")
        mark = "OK" if good else ("SKIP" if (dry_run or is_skip) else "FAIL")
        body = msg.removeprefix("SKIP|")
        say(f"         -> {mark} {body}")
        if is_skip:
            skipped += 1
        elif dry_run:
            pass                     # 体检不上报, 不能记成失败
        else:
            ok += good
            fail += (not good)
        if good:
            touched.add(sec["section_id"])
        if not dry_run:
            time.sleep(random.uniform(2.0, 5.0))

    if dry_run:
        done = sum(1 for x in secs if x["finish"] in DONE_FINISH)
        say(f"\n[dry-run] 体检完成：待学 {len(todo)} 个（其中需本人完成 {skipped} 个），"
            f"未上报任何进度 | 小节完成度 {done}/{len(secs)}")
        if report is not None:
            report.update(ok=ok, fail=fail, skipped=skipped, done=done, total=len(secs))
        return done, len(secs)

    # 回读复核：父小节 settle 后可能被平台复核打回 0，补一次 settle
    sync_sections(s, course_id, secs)
    secs2 = fetch_sections(s, course_id, det)      # 回读只 GET，不再重复 register
    back = [x for x in secs2 if x["section_id"] in touched and x["finish"] not in DONE_FINISH]
    if back:
        say(f"\n[修复] {len(back)} 个本次已处理的小节回退到未完成，重新 settle")
        for x in back:
            if x["type"] == NESTED_TYPE:
                good = settle_nested(s, course_id, x["resource_id"], x["section_id"])
            else:
                good, _ = study_section(s, x, chunk=chunk, dry_run=False,
                                        parent_id=course_id, course_id=course_id, depth=depth)
            say(f"         {'✅' if good else '⏳'} {x['name'][:30]}")
        secs2 = fetch_sections(s, course_id, det)

    done = sum(1 for x in secs2 if x["finish"] in DONE_FINISH)
    skip_note = f" / 需本人完成 {skipped}" if skipped else ""
    say(f"\n结果: 成功 {ok} / 失败 {fail}{skip_note} | 小节完成度 {done}/{len(secs2)}")
    if report is not None:
        report.update(ok=ok, fail=fail, skipped=skipped, done=done, total=len(secs2))
    return done, len(secs2)


def wait_finish(s, course_id: str, timeout: int) -> bool:
    """只读轮询课程/专题层完成态（服务端异步结算，实测 2–18 分钟）。"""
    t0 = time.time()
    while True:
        try:
            if course_finish(s, course_id) in DONE_FINISH:
                say(f"[复核] 平台已完成汇总（等待 {int(time.time() - t0)}s）")
                return True
        except Exception as exc:
            say(f"[复核] 查询失败 {type(exc).__name__}: {exc}")
        if time.time() - t0 >= timeout:
            say(f"[复核] 平台尚未汇总（已等 {int(time.time() - t0)}s）；"
                "服务端异步结算实测需 2–18 分钟，稍后重跑可复查，不必重新学")
            return False
        time.sleep(min(30, max(1, timeout - (time.time() - t0))))


# ---------------------------------------------------------------- 目标模式

def _today_used_path():
    """本地当日用量账本。data/ 已在 .gitignore 里。"""
    import os
    from pathlib import Path
    home = os.environ.get("TOBACCO_HOME")
    base = Path(home) if home else Path(__file__).resolve().parent.parent / "data"
    return base / "today_used.json"


def today_used() -> float:
    """今天已经通过 --today 学掉的学时。跨日自动归零。

    平台没有按天的学时明细接口，只能本地记账；否则同一天跑两次 --today
    会各给一份额度，等于把"分批学"变成"一次刷两倍"。
    """
    import datetime
    import json
    try:
        obj = json.loads(_today_used_path().read_text(encoding="utf-8"))
    except Exception:
        return 0.0
    if obj.get("date") != datetime.date.today().isoformat():
        return 0.0
    return max(0.0, float(obj.get("used") or 0))


def record_today_used(delta: float | None) -> None:
    """把本次真实增加的学时记到当天（只记正数，dry-run / 0 不记）。"""
    import datetime
    import json
    if not delta or delta <= 0:
        return
    p = _today_used_path()
    used = round(today_used() + float(delta), 2)
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps({"date": datetime.date.today().isoformat(), "used": used},
                                ensure_ascii=False), encoding="utf-8")
    except OSError as exc:                      # 记账失败不该影响学习
        say(f"[今日] 本地记账失败（不影响已学学时）：{exc}")


def _today_capacity() -> tuple[float, dict]:
    """今日可学学时容量：读本地工作档位（tobacco.py 的 profile.json），按工作日/周末取值。"""
    try:
        from tobacco import load_profile
        prof = load_profile()
    except Exception:                       # 没配档位就按保守默认
        prof = {"label": "默认", "weekday_hours": 2.0, "weekend_hours": 4.0}
    import datetime
    weekend = datetime.date.today().weekday() >= 5
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


def main(argv=None) -> int:
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
    p.add_argument("--dry-run", action="store_true", help="只体检：看选课与剩余时长，不上报")
    p.add_argument("--chunk", type=int, default=600, help="单轮上报秒数（默认 600）")
    p.add_argument("--wait-sync", type=int, default=0, metavar="秒",
                   help="学完后只读等待专题层汇总的秒数（0=不等，实测需 2–18 分钟）")
    p.add_argument("--json", action="store_true", help="结束时额外输出 JSON 摘要")
    a = p.parse_args(argv)

    token, meta = load_session()
    s = api_session(token)
    # 端归属：账密 app-login 属于 APP 端会话，扫码属于网页端会话；平台按端单会话
    src = meta.get("token_source") or "unknown"
    side = {"app-login": "APP 端（账密登录）",
            "qr-wechat": "网页端（微信扫码）",
            "qr-app": "网页端（APP 扫码）"}.get(src, "未知")
    say(f"[会话] token 有效至 {meta.get('expires_at') or '未知'}｜来源 {side}")
    say("[会话] 平台按端单会话（enableUnique=1）：学习期间别在同一端 App/网页里同时操作，"
        "否则会互相顶下线")

    if a.list or not (a.course or a.hours is not None or a.todo or a.today):
        show_list(s)
        _result("list", undone=len(undone_tasks(s)))
        return 0

    h0, need = None, 0.0
    if not a.list:
        try:
            h0, need = net_hours(s)          # 入口读一次，末尾用它算增量并记账
        except Exception as exc:
            if a.hours is not None or a.today:
                say(f"[错误] 读取学时总览失败，无法算出目标：{exc}")
                _result("today" if a.today else "hours", failed=1)
                return 1
            say(f"[学时] 总览读取失败，本次不记账：{exc}")
    if a.course:
        targets = [resolve_course(s, x) for x in a.course]
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
            used = today_used()
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
    last_mark = h0                      # 已落账到的学时读数，逐门推进
    if mode in ("hours", "today"):
        # 学时/今日目标：边刷边看 hourSelf，达标即停（today 的额度就是 deficit）
        for i, (cid, name) in enumerate(targets, 1):
            say(f"\n########## 学时目标 [{i}/{len(targets)}] {(name or cid)[:40]} ##########")
            rep = {}
            try:
                done, total = run_course(s, cid, chunk=a.chunk, dry_run=a.dry_run,
                                         title=name, report=rep)
            except QuotaExhausted:
                stat["failed"] += 1
                say("[学时] ⛔ 当日配额已满，停止")
                break
            except RuntimeError as exc:
                stat["failed"] += 1
                say(f"[学时] ⚠️ 读取失败：{exc}")
                if not a.dry_run:
                    gained = net_hours(s)[0] - h0
                    if gained >= deficit:      # 已经够额度就别再开下一门
                        say(f"[学时] 🎉 已达成：+{gained:.2f} 学时（回读失败前已完成）")
                        break
                continue
            stat["courses"] += 1
            stat["done"] += done
            stat["total"] += total
            if rep.get("fail"):
                stat["failed"] += 1
            if a.dry_run:
                continue
            now = net_hours(s)[0]
            gained = now - h0
            if not a.dry_run and last_mark is not None:
                record_today_used(now - last_mark)     # 每门课落一次账
                last_mark = now
            say(f"[学时] 已累计 +{gained:.2f}/{deficit:.2f} 学时")
            if gained >= deficit:
                say(f"[学时] 🎉 已达成：+{gained:.2f} 学时")
                break
        if not a.dry_run and a.wait_sync and stat["courses"]:
            deadline = time.time() + a.wait_sync
            for cid, _name in targets[:stat["courses"]]:
                if wait_finish(s, cid, a.wait_sync, deadline=deadline):
                    stat["confirmed"] += 1
        if not a.dry_run and gained is not None and gained < deficit:
            stat["failed"] += 1
            say(f"[学时] ⚠️ 目标未达成：实际 +{gained:.2f}/{deficit:.2f} 学时"
                f"（候选课已用完，或都被跳过）")
    else:
        stat = run_targets(s, targets, chunk=a.chunk, dry_run=a.dry_run, wait=a.wait_sync)

    gained = round(net_hours(s)[0] - h0, 2) if h0 is not None else None
    if not a.dry_run and gained is not None:
        done_before = (last_mark - h0) if last_mark is not None else 0.0
        record_today_used(gained - done_before)   # 只补记还没落账的部分
    say("\n========== 汇总 ==========")
    say(f"目标 {stat['courses']}/{len(targets)} | 小节 {stat['done']}/{stat['total']} | "
        f"失败 {stat['failed']}" + (f" | 学时 +{gained}" if gained is not None else ""))
    if stat["failed"]:
        say("（⚠️ 有失败项；⏳ 表示已学完但平台尚未汇总，不要重跑，会白扣配额）")
    _result(mode, courses=stat["courses"], done=stat["done"], total=stat["total"],
            failed=stat["failed"], hours_gained=gained)
    if a.json:
        print(json.dumps({"mode": mode, "courses": stat["courses"], "done": stat["done"],
                          "total": stat["total"], "failed": stat["failed"],
                          "hours_gained": gained}, ensure_ascii=False))
    return 0 if not stat["failed"] else 1


if __name__ == "__main__":                     # pragma: no cover
    sys.exit(main())
