#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
烟草网络学院 —— 自动伪造心跳刷满学时
====================================
逆向依据 (2026-11-03 实测)
--------------------------
1. 学习会话由 `course-front/start-progress/<sectionId>` 创建, 返回
   `{id: 学习日志logId, remainingTime: 该小节剩余秒数}`。
   关键: 该接口支持 `createTime` 参数 (毫秒时间戳), 本意是"离线学习记录回放"
   时告诉服务端这条日志的真实起始时间。服务端用它做反作弊校验:
        本次上报的 studyTime <= now - createTime
   —— 也就是说把 createTime 伪造成过去时刻, 就能一次性上报任意时长。

2. 音视频小节 (`sectionType` 5=mp3 / 6=mp4) 用:
       POST course-front/video-progress
       form: encrypt=false & logId & studyTime & lessonLocation & resourceTotalTime & flush
   每条日志只能提交一次, 提交后即失效 (再提交返回 40909), 故需重新 start-progress。

3. 文档类小节 (1=pdf / 2=image / 3=url / 7=epub) 用:
       POST course-front/doc-progress
       form: encrypt=false & logId [& lessonLocation]
   该接口无 studyTime, 服务端按日志存在时长计学时, 同样受 createTime 影响。

3.1 音频学习模式 (`--mode audio`):
   App 里"视频/音频"切换只影响客户端播放器, 不换接口 —— 音频组件同样调
   video-progress, 字段完全一致。差异只有两点:
     · 取 mp3 音轨 (`course-study/file/info-app/<resourceId>` 里 def=4 / 以 .mp3 结尾)
     · 上报节奏按 submitProgressIntervals=300000ms, 即 5 分钟一次
   故音频模式 = 300s 一档 + 使用 mp3 课时长, 时间线更像真人听音频。

4. 完成判定 (rule-config):
       VIDEO_PALY_THRESHOLD=100        → 累计学时需达课件时长的 100%
       VIDEO_PROCESS_THRESHOLD=0       → 播放进度不参与判定
   达标后 progress.finishStatus 自动置 2 (已完成), completedRate=100。

5. 心跳通道 (防"掉线/多端"检测):
       wss://mooc.ctt.cn/api/v1/course-study/ws/course?token=<access_token>
       每 10s 发文本 "PING", 服务端回 "PONG"。前端另有 otherClientStudy /
       multipleClientStudy / timeExpand_<秒> 等下行指令。

用法
----
    python mooc_auto_study.py --list                    # 看未完成任务
    python mooc_auto_study.py --course <courseId>       # 刷满单个专题/课程
    python mooc_auto_study.py --all                     # 刷满全部未完成课程/专题
    python mooc_auto_study.py --course <id> --dry-run   # 只体检, 不上报
    python mooc_auto_study.py --course <id> --chunk 600 --no-ws
    python mooc_auto_study.py --course <id> --mode audio # 音频学习模式 (mp3 + 5分钟一档)
"""

import argparse
import json
import pathlib
import random
import re
import sys
import threading
import time
import uuid

import requests

from mooc_client import BASE, fresh_token, load_token_safe
from mooc_ws import WSClient, WSClosed

# 小节类型 (module-study 内 sectionTypes)
TYPE_NAME = {1: "pdf", 2: "image", 3: "url", 4: "scorm", 5: "mp3", 6: "mp4",
             7: "epub", 8: "task", 9: "exam", 10: "other", 12: "survey",
             13: "assessment", 15: "kj"}
# 小节/课程/专题的完成态: 前端 module-study.js 的 formatSectionStatus 只把 2 和 4 当完成
# （2 → icon-replay「重播/复习」，4 → icon-finish「完成打勾」），各处判定均写
# `2 !== finishStatus && 4 !== finishStatus` 为未完成。所以「复习」就是 2，不是独立值。
DONE_FINISH = {2, 4}
FINISH_NAME = {0: "未开始", 1: "学习中", 2: "已完成(复习)", 4: "已完成"}
# 任务接口 status: 1=未开始/未完成, 2=进行中, 3=已完成（平台 UI 上已完成的任务显示“复习”）
# 实测 2026-11-04: 一个 5 小节全完成的专题从 status=1 变为 3, 而它截止 2026-12-31 未到期。
# 过期跟完成无关 —— 由独立的 expired 布尔字段表示, 不是 status=3。
def cn_today():
    """平台账期按北京时间计; 本机不在东八区时 date.today() 会算错「今天」。"""
    from datetime import datetime, timedelta, timezone
    return datetime.now(timezone(timedelta(hours=8))).date()

def _today_used_path():
    """本地当日用量账本。data/ 已在 .gitignore 里。"""
    import os
    from pathlib import Path
    home = os.environ.get("TOBACCO_HOME")
    # 不再往上跳一级: 旧写法把账本放到仓库外层, 多个 worktree 会互相覆盖
    base = Path(home) if home else Path(__file__).resolve().parent / "data"
    return base / "today_used.json"

def _today_ledger() -> dict:
    import json
    try:
        return json.loads(_today_used_path().read_text(encoding="utf-8")) or {}
    except Exception:
        return {}


def today_used(hour_self: float | None = None) -> float:
    """今天已学（学时）。优先「平台结算口径」= last − base，兼容旧账本的 used。"""
    obj = _today_ledger()
    if obj.get("date") != cn_today().isoformat():
        return 0.0
    if "base" in obj and "last" in obj:
        last = float(obj["last"] if hour_self is None else hour_self)
        return max(0.0, round(last - float(obj["base"]), 2))
    return max(0.0, float(obj.get("used") or 0))


def record_today_hours(hour_self: float, session_base: float | None = None) -> None:
    """用平台 hourSelf 落账：当天首次以（学习前读数 或 现值）为基准，之后只更新现值。"""
    if hour_self is None or float(hour_self) <= 0:
        return
    today = cn_today().isoformat()
    obj = _today_ledger()
    legacy = (float(obj.get("used") or 0)
              if obj.get("date") == today and "base" not in obj else 0.0)
    if obj.get("date") != today or "base" not in obj:
        base = round((float(session_base) if session_base is not None
                      else float(hour_self)) - legacy, 2)
        obj = {"date": today, "base": base, "last": round(float(hour_self), 2)}
    else:
        obj["last"] = round(float(hour_self), 2)
    try:
        p = _today_used_path()
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(obj, ensure_ascii=False), encoding="utf-8")
    except OSError as exc:
        print(f"[今日] 本地记账失败（不影响已学学时）：{exc}", flush=True)


def record_today_used(delta: float | None) -> None:
    """兼容旧调用：旧账本按增量累加；新账本由 hourSelf 口径覆盖，忽略。"""
    import json
    if not delta or delta <= 0:
        return
    obj = _today_ledger()
    if "base" in obj:
        return
    p = _today_used_path()
    used = round(today_used() + float(delta), 2)
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps({"date": cn_today().isoformat(), "used": used},
                                ensure_ascii=False), encoding="utf-8")
    except OSError as exc:                      # 记账失败不该影响学习
        say(f"[今日] 本地记账失败（不影响已学学时）：{exc}")

def _today_capacity() -> tuple[float, dict]:
    """今日可学学时容量：读本地工作档位（tobacco.py 的 profile.json），按工作日/周末取值。"""
    try:
        from tobacco import load_profile
        prof = load_profile()
    except Exception:
        # tobacco.py 缺失/损坏时逐级回退: 先用其内置默认档, 再退到保守固定值
        try:
            from tobacco import DEFAULT_PROFILE as _DP, WORK_PROFILES as _WP
            prof = dict(_WP[_DP])
        except Exception:
            prof = {"label": "默认", "weekday_hours": 2.0, "weekend_hours": 4.0}
    weekend = cn_today().weekday() >= 5
    cap = float(prof.get("weekend_hours" if weekend else "weekday_hours") or 0)
    return cap, prof

def _ics_escape(text) -> str:
    """RFC 5545 文本转义：反斜杠、分号、逗号、换行。"""
    return (str(text or "").replace("\\", "\\\\").replace(";", r"\;")
            .replace(",", r"\,").replace("\r\n", r"\n").replace("\n", r"\n"))

def _ics_fold(line: str) -> str:
    """RFC 5545：单行不超过 75 字节，续行以空格开头（中文按 UTF-8 字节算）。"""
    data = line.encode("utf-8")
    if len(data) <= 75:
        return line
    parts, cur = [], ""
    for ch in line:
        if len((cur + ch).encode("utf-8")) > 74:
            parts.append(cur)
            cur = ch
        else:
            cur += ch
    parts.append(cur)
    return "\r\n ".join(parts)
TASK_DONE = 3
TASK_UNDONE = (1, 2)
MEDIA_TYPES = {5, 6}            # 走 video-progress
DOC_TYPES = {1, 2, 3, 7}        # 走 doc-progress
NESTED_TYPE = 10                # 关联课程: resourceId 即子课程 courseId, 需递归
# 需要真实答题/提交的, 伪造心跳无意义, 直接跳过
SKIP_TYPES = {4, 8, 9, 12, 13, 15}
MAX_DEPTH = 2                   # 专题 → 子课程 的递归深度

API_START = "api/v1/course-study/course-front/start-progress"
API_VIDEO = "api/v1/course-study/course-front/video-progress"
API_DOC = "api/v1/course-study/course-front/doc-progress"
API_REGISTER = "api/v1/course-study/course-front/register"
API_CHAPTERS = "api/v1/course-study/subject/chapter-progress"
API_TASKS = "api/v1/human/task"
API_DETAIL_HOUR = "api/v1/system/cadre-education/detail-hour-member"
API_PERSON_COURSE = "api/v1/course-study/course-study-progress/personCourse-list"
API_FILE = "api/v1/course-study/file/info-app"
API_SECTION_PROGRESS = "api/v1/course-study/course-front/course-section-progress"
# 完成态只读查询 / 进度重算（对齐前端 updateCourseProgress、commitProgressUpdate）
API_COURSE_INFO = "api/v1/course-study/course-front/course-info-progress"
API_PROGRESS_UPD = "api/v1/course-study/course-front/course-progress-update"
# 平台课程库全局搜索（type=0 课程 / type=2 专题；publishClient=1 必填）
API_GLOBAL_SEARCH = "api/v1/course-study/course-front/findPageForGlobalSearch"
# 学习记录（最近学习/在学的课程与专题）
API_COURSELOG = "api/v1/course-study/course-study-progress/person-courselog"
API_COURSE_FRONT = "api/v1/course-study/course-front"   # info/<id> 详情、registerStudy 报名
# 课程库课程的 fileType → 小节类型（与 sectionType 对齐）
FTYPE = {"mp4": 6, "mp3": 5, "pdf": 1, "image": 2, "url": 3, "epub": 7}
WS_URL = "wss://mooc.ctt.cn/api/v1/course-study/ws/course?token="


# ---------------------------------------------------------------- 心跳线程

def render_ics(tasks, today=None, alarm_days=3, mask_titles=True):
    """必修任务截止日 → iCalendar（只含未完成必修；课程名默认脱敏）。"""
    import datetime as dt
    today = today or cn_today()   # 截止日按北京时间计, 与账期一致
    n = 0
    lines = ["BEGIN:VCALENDAR", "VERSION:2.0",
             "PRODID:-//tobacco-mooc-study//mooc_auto_study//CN", "CALSCALE:GREGORIAN"]
    for t in tasks:
        if t.get("businessType") not in (1, 2):
            continue
        if t.get("status") == TASK_DONE or t.get("expired"):
            continue
        ms = t.get("endTime") or 0
        if not ms:
            continue
        dl = dt.date.fromtimestamp(ms / 1000)
        if dl < today:
            continue                       # 已过期的截止日不再提醒
        n += 1
        label = {1: "课程", 2: "专题"}.get(t.get("businessType"),
                                           str(t.get("businessType")))
        title = f"必修任务 #{n}" if mask_titles else (t.get("name") or "")
        left = (dl - today).days
        summary = f"【截止】{label} · {title}（还差 {left} 天）"
        stamp = today.strftime("%Y%m%d") + "T000000Z"
        lines += ["BEGIN:VEVENT", f"UID:{t.get('businessId')}@mooc-auto-study",
                  f"DTSTAMP:{stamp}", f"DTSTART;VALUE=DATE:{dl.strftime('%Y%m%d')}",
                  _ics_fold(f"SUMMARY:{_ics_escape(summary)}")]
        if alarm_days > 0:
            lines += ["BEGIN:VALARM", f"TRIGGER:-P{alarm_days}D", "ACTION:DISPLAY",
                      _ics_fold(f"DESCRIPTION:{_ics_escape(summary)}"), "END:VALARM"]
        lines.append("END:VEVENT")
    lines.append("END:VCALENDAR")
    return "\r\n".join(lines) + "\r\n"


class Heartbeat(threading.Thread):
    """维护课程学习 WebSocket, 每 10s 发 PING, 断线自动重连。

    这条通道是平台"在线/单端学习"的凭据, 伪造它可以让服务端认为
    客户端确实在播放课件, 避免 otherClientStudy / 掉线判定。
    """

    def __init__(self, token, interval=10, verbose=True):
        super().__init__(daemon=True)
        self.token = token
        self.interval = interval
        self.verbose = verbose
        self.stop_flag = threading.Event()
        self.beats = 0
        self.last_error = None

    def run(self):
        while not self.stop_flag.is_set():
            ws = None
            try:
                ws = WSClient(WS_URL + self.token)
                if self.verbose:
                    print("[心跳] WebSocket 已连接")
                ws.send("PING")
                self.beats += 1
                ws.sock.settimeout(self.interval)
                while not self.stop_flag.is_set():
                    deadline = time.time() + self.interval
                    while time.time() < deadline and not self.stop_flag.is_set():
                        try:
                            msg = ws.recv_text(timeout=max(0.5, deadline - time.time()))
                        except Exception:
                            break
                        if msg == "timeExpand_":
                            pass
                        if msg in ("otherClientStudy", "multipleClientStudy"):
                            print(f"[心跳] 服务端下发 {msg}: 有其它端在学同一门课")
                    if self.stop_flag.is_set():
                        break
                    ws.send("PING")
                    self.beats += 1
            except Exception as e:
                self.last_error = e
                if self.verbose:
                    print(f"[心跳] 断开({type(e).__name__}), 3s 后重连")
                if self.stop_flag.wait(3):
                    break
            finally:
                if ws is not None:
                    try:
                        ws.close()
                    except Exception:
                        pass

    def stop(self):
        self.stop_flag.set()


# ---------------------------------------------------------------- 学习机器人

class QuotaExhausted(Exception):
    """当日学时配额已满 —— 上报不再生效, 应立即停止全部处理。"""

class BotStopped(Exception):
    """收到停止请求（TUI 退出/切换账号）—— 一路抛到最外层立即收尾, 不当作任务失败。"""


class StudyBot:
    def __init__(self, verbose=True, dry_run=False, chunk=None, ws=True, mode="auto", say=None,
                 wait_sync=1200, nest_confirm=0):
        self.say = say or print
        self.verbose = verbose
        # 学完后等服务端异步汇总的秒数。实测延迟 2–18 分钟（354 条记录里 80 条是批量落库），
        # 5 分钟不够 —— 默认给 20 分钟；批量跑时共享这一份预算，不逐个等。
        self.wait_sync = wait_sync
        self.nest_confirm = nest_confirm     # 父小节 settle 后隔多久回读确认稳定性
        self.last_result = {}
        self._auth_lock = threading.Lock()     # 仅保护 token 重登
        self._stop = threading.Event()         # 全局停止标记: 退出/切号时置位, 学习循环见它即退
        self.dry_run = dry_run
        self.mode = mode                       # auto | audio | video
        # 音频模式对齐 App 的 submitProgressIntervals (300000ms)
        self.chunk = chunk or (300 if mode == "audio" else 600)
        self.s = requests.Session()
        self.s.trust_env = False
        self.token = fresh_token()
        self._media_cache = {}
        self.hb = None
        if ws and not dry_run:
            self.hb = Heartbeat(self.token["access_token"], verbose=verbose)
            self.hb.start()

    # ------------------------------------------------------------ 基础请求
    def _headers(self):
        t = self.token
        return {"Authorization": f"{t.get('token_type','Bearer')}__{t['access_token']}",
                "Accept": "application/json;charset=UTF-8",
                "X-Requested-With": "XMLHttpRequest"}

    def _req(self, method, path, params=None, data=None, _retry=True):
        url = BASE + path.lstrip("/")
        r = self.s.request(method, url, params=params, data=data,
                           headers=self._headers(), timeout=25)
        # 凭证失效 → 重登一次
        body = None
        if "json" in r.headers.get("content-type", ""):
            try:
                body = r.json()
            except Exception:
                body = None
        if (_retry and (r.status_code == 401 or
                        (isinstance(body, dict) and body.get("errorCode") in (90901, 90902)))):
            with self._auth_lock:               # 重登互斥, 其余请求不串行
                tok = load_token_safe()
                if tok and tok.get("access_token") == self.token.get("access_token"):
                    self.token = fresh_token(force=True)
                else:
                    self.token = tok or fresh_token(force=True)
            r = self.s.request(method, url, params=params, data=data,
                               headers=self._headers(), timeout=25)
            body = r.json() if "json" in r.headers.get("content-type", "") else None
        return r.status_code, body

    # ------------------------------------------------------------ 任务/课程
    def list_tasks(self):
        # 单次全量 (pageSize=500), 避免分页期间服务端排序漂移导致列表不稳定
        _, body = self._req("GET", API_TASKS,
                            params={"page": 1, "pageSize": 500,
                                    "status": "", "filterAuthExam": 1})
        items = (body or {}).get("items") or []
        seen, uniq = set(), []
        for t in items:
            if t["id"] not in seen:
                seen.add(t["id"])
                uniq.append(t)
        return uniq

    def sections(self, course_id, version_id, register):
        _, body = self._req("GET", API_CHAPTERS,
                            params={"courseId": course_id, "versionId": version_id,
                                    "isRegister": register})
        out = []
        for ch in body if isinstance(body, list) else []:
            for sec in ch.get("courseChapterSections") or []:
                p = sec.get("progress") or {}
                out.append({
                    "section_id": sec.get("referenceId"),
                    "resource_id": sec.get("resourceId"),
                    "name": sec.get("name") or sec.get("sectionName") or "",
                    "type": sec.get("sectionType"),
                    "finish": p.get("finishStatus", 0),
                    "rate": p.get("completedRate") or 0,
                    "studied": p.get("studyTotalTime") or 0,
                })
        return out

    def open_library_course(self, course_id):
        """课程库课程（未加入"我的课程"）：registerStudy 报名 + info/<id> 取章节。

        实测 2026-11-05（浏览器 HAR）：报名 body 需 type=1&isRequired=0；
        章节在 GET course-front/info/<id>?source=1&type=1 的 courseChapters 里，
        section.id 即 start-progress 用的 sectionId，attachmentId 即资源 id。
        """
        self._req("POST", API_COURSE_FRONT + "/registerStudy",
                  data={"courseId": course_id, "type": 1, "isRequired": 0})
        _, det = self._req("GET", f"{API_COURSE_FRONT}/info/{course_id}",
                           params={"source": 1, "type": 1})
        det = det or {}
        det["_library"] = True
        secs = []
        for ch in det.get("courseChapters") or []:
            for sec in ch.get("courseChapterSections") or []:
                ft = (sec.get("fileType") or "").lower()
                secs.append({"section_id": sec.get("id"),
                             "resource_id": sec.get("attachmentId"),
                             "name": sec.get("name") or sec.get("sectionName") or "",
                             "type": FTYPE.get(ft, 0), "finish": 0, "studied": 0})
        return det, secs

    def open_course(self, course_id):
        code, det = self._req("POST", API_REGISTER, data={"courseId": course_id})
        if code != 200 or not isinstance(det, dict) or not det:
            return self.open_library_course(course_id)   # 课程库课程（未加入我的课程）
        return det, self.sections(course_id, det.get("versionId", ""),
                                  det.get("register", False))

    # ------------------------------------------------------------ 音轨
    def media_sources(self, resource_id):
        """返回 (mp3信息, mp4信息); 无则 None。def=4 即 App 的音频转码版本。"""
        if resource_id in self._media_cache:
            return self._media_cache[resource_id]
        if not resource_id:
            return None, None
        code, body = self._req("GET", f"{API_FILE}/{resource_id}")
        mp3 = mp4 = None
        for it in body if isinstance(body, list) else []:
            path = (it or {}).get("path") or ""
            if path.lower().split("?")[0].endswith(".mp3") or it.get("def") == 4:
                mp3 = mp3 or it
            elif path.lower().split("?")[0].endswith(".mp4"):
                mp4 = mp4 or it
        self._media_cache[resource_id] = (mp3, mp4)
        return mp3, mp4

    # ------------------------------------------------------------ 单小节伪造
    def _start(self, section_id, backdate_s, client_type=1):
        """创建学习日志; createTime 回溯 backdate_s 秒 → 放宽时长校验。

        client_type: 1="我的课程"路径；0=课程库课程（HAR 实测）。
        """
        now_ms = int(time.time() * 1000)
        ct = now_ms - int(backdate_s * 1000)
        code, body = self._req("GET", f"{API_START}/{section_id}",
                               params={"clientType": client_type, "createTime": ct})
        if code != 200 or not isinstance(body, dict) or not body.get("id"):
            return None, None
        return body["id"], body.get("remainingTime")

    def _commit_video(self, log_id, study, loc, total):
        return self._req("POST", API_VIDEO, data={
            "encrypt": "false", "logId": log_id, "studyTime": int(study),
            "lessonLocation": int(loc), "resourceTotalTime": int(total),
            "flush": "false"})

    def _commit_video_enc(self, log_id, study, loc, total):
        """课程库课程的 video-progress：全字段 AES-128-ECB + 随机 singleMark。

        实测（HAR 解密）：logId/lessonLocation/studyTime/resourceTotalTime/
        organizationId 均为密文，singleMark 是随机 UUID 的密文；无 encrypt 字段。
        """
        from mooc_api_login import enc
        return self._req("POST", API_VIDEO, data={
            "logId": enc(log_id), "lessonLocation": enc(loc), "studyTime": enc(study),
            "resourceTotalTime": enc(total), "organizationId": enc(1),
            "singleMark": enc(str(uuid.uuid4()))})

    def _commit_doc_enc(self, log_id, loc=None, single_mark=None):
        """课程库课程的 doc-progress：与 video 同款全字段 AES（逆向 commitDocProgress）。"""
        from mooc_api_login import enc
        d = {"logId": enc(log_id), "organizationId": enc(1),
             "singleMark": enc(single_mark or str(uuid.uuid4()))}
        if loc is not None:
            d["lessonLocation"] = enc(loc)
        return self._req("POST", API_DOC, data=d)

    def _commit_doc(self, log_id, loc=None):
        d = {"encrypt": "false", "logId": log_id}
        if loc is not None:
            d["lessonLocation"] = int(loc)
        return self._req("POST", API_DOC, data=d)

    def section_progress(self, parent_course_id, child_course_id):
        """只读父小节的进度值（POST 一次批量查，不产生学习记录）。"""
        _, rows = self._req("POST", API_SECTION_PROGRESS,
                            data={"courseId": parent_course_id,
                                  "resourceIds": child_course_id})
        if isinstance(rows, list) and rows:
            return rows[0].get("finishStatus")
        return None

    def settle_nested(self, parent_course_id, child_course_id, section_id, tries=4,
                      confirm=0):
        """关联课程父小节: 子课程完成后, 让平台把父记录判为完成。

        实测要点:
          1. 父记录需要先存在 —— POST course-front/course-section-progress
             (form: courseId=专题, resourceIds=子课程id) 会创建一条 sectionType=10 的进度行
          2. 之后 start-progress + doc-progress 打心跳: 第一次置 1(学习中)
          3. 平台核对子课程完成后置 2, 该步为异步, 可能需重试或稍后再来
        4. **不稳定**: 实测 5ec986a0（2026-11-05）父小节 settle 成 2 后又被复核打回 0，
           因为子课程的完成态当时还没落库。confirm>0 时等一段时间再回读，回退就重新 settle。
        """
        self._req("POST", API_SECTION_PROGRESS,
                  data={"courseId": parent_course_id, "resourceIds": child_course_id})

        for _ in range(tries):
            log_id, _ = self._start(section_id, 3600)
            if log_id:
                _, body = self._commit_doc(log_id)
                if isinstance(body, dict) and body.get("finishStatus") in DONE_FINISH:
                    break
            self._sleep(random.uniform(2.5, 4.0))

        if confirm:
            self._sleep(confirm)
        got = self.section_progress(parent_course_id, child_course_id)
        return got in DONE_FINISH

    def fake_section(self, sec, chunk=None, depth=0, parent_course_id=None, course_id=None,
                     library=False, stats=None, budget=None):
        """把单个小节刷到完成态（finishStatus 2=复习 / 4=完成）。返回 (成功?, 说明)。

        budget: 本次还允许提交的秒数（None=不限）。到点停在半节并把
        stats["partial"] 置 True，让上层停在配额内而不是整门跑完才查。
        """
        stats = stats if stats is not None else {}
        chunk = chunk or self.chunk
        sid, stype = sec["section_id"], sec["type"]
        name = (sec["name"] or "")[:40]

        if stype in SKIP_TYPES:
            return False, f"类型 {TYPE_NAME.get(stype, stype)} 需真实作答, 跳过"
        if sec["finish"] in DONE_FINISH:
            return True, "已完成, 跳过"

        # 关联课程: 递归刷子课程, 再用心跳提交把父小节判为已完成
        if stype == NESTED_TYPE:
            if depth >= MAX_DEPTH:
                return False, "嵌套过深, 跳过"
            self.say(f"         ↳ 关联课程 {sec['resource_id']}")
            sub = {}
            done, total = self.run_course(sec["resource_id"], depth=depth + 1,
                                          report=sub, budget=budget)
            stats["submitted"] = float(sub.get("submitted") or 0)
            if sub.get("partial"):
                stats["partial"] = True
                return True, f"已达本次学时额度（子课程已提交 {stats['submitted']:.0f}s）"
            if self.dry_run:
                return False, f"[dry-run] 子课程 {done}/{total}"
            if done < total:
                return False, f"子课程未完成 {done}/{total}"
            settled = self.settle_nested(parent_course_id, sec["resource_id"], sid)
            return settled, ("子课程完成 + 父记录已判完成" if settled
                             else f"子课程 {done}/{total}, 父记录待平台复核(可稍后 --sync)")

        # 音频模式: 用 App 转码出的 mp3 音轨 (def=4), 课时长以服务端为准
        audio_note = ""
        if stype in MEDIA_TYPES and self.mode != "video":
            mp3, mp4 = self.media_sources(sec.get("resource_id"))
            use = mp3 or (mp4 if self.mode == "auto" else None)
            if mp3:
                mb = (mp3.get("size") or 0) / 1048576
                audio_note = f"音轨 mp3 {mb:.1f}MB"
            elif self.mode == "audio":
                audio_note = "无 mp3 音轨, 回退 mp4"
            else:
                audio_note = "无 mp3 音轨, 用 mp4"
            if use and self.verbose:
                self.say(f"         ({audio_note})")

        if self.dry_run:
            _, rem = self._start(sid, 3600, 0 if library else 1)
            return False, (f"[dry-run] 剩余 {rem}s | {TYPE_NAME.get(stype, stype)}"
                           f"{' | ' + audio_note if audio_note else ''}")

        total = None
        session_uuid = str(uuid.uuid4()) if library else None
        rounds = 0
        submitted = 0
        prev_rem = None
        stuck = 0
        for _ in range(60):
            if self.stopped():
                raise BotStopped()
            rounds += 1
            # 每次上报都需要一条新日志: 先取剩余时长, 同时回溯 createTime
            log_id, rem = self._start(sid, chunk + random.randint(60, 300), 0 if library else 1)
            if log_id is None:
                return False, "start-progress 失败"
            if rem is None:
                rem = 0
            if rem <= 0:
                # 时长已耗尽：本轮已上报过 → 学完了，只是完成态还没落库（待平台汇总）
                if submitted or sec.get("studied"):
                    stats["submitted"] = submitted
                    return True, f"学习时长已用完（待平台汇总，共 {submitted}s）"
                break

            # 配额熔断: 平台单日累计学时上限(24h)耗尽后, 上报仍返回 200
            # 但 remainingTime 不再下降。连续 2 轮无进展即终止, 避免空转。
            if prev_rem is not None and rem >= prev_rem:
                stuck += 1
                if stuck >= 2:
                    raise QuotaExhausted(
                        "剩余时长未下降 —— 当日学时配额已满(平台单日上限), 请次日重跑")
            else:
                stuck = 0
            prev_rem = rem

            if total is None:
                total = rem + sec["studied"]
            step = min(chunk, rem)
            if budget is not None:
                left = budget - submitted
                if left <= 1:
                    # 本次额度到点: 半节收工并记 partial, 让上层停而不是继续多报
                    stats["submitted"] = submitted
                    stats["partial"] = True
                    return True, (f"已达本次学时额度（本小节未完成, 已提交 {submitted}s"
                                  f" / 需 {total:.0f}s）" if total else
                                  f"已达本次学时额度（已提交 {submitted}s）")
                step = max(1, min(step, int(left)))
            loc = min(total, total - rem + step)

            if stype in MEDIA_TYPES:
                code, body = (self._commit_video_enc(log_id, step, loc, total) if library
                              else self._commit_video(log_id, step, loc, total))
            else:
                code, body = (self._commit_doc_enc(log_id, loc, session_uuid) if library
                              else self._commit_doc(log_id, loc))

            if code != 200:
                # 40909: 日志已用尽/失效 → 换一条再来
                if isinstance(body, dict) and body.get("errorCode") == 40909:
                    self._sleep(1)
                    continue
                stats["submitted"] = submitted
                return False, f"上报失败 HTTP {code} {body}"

            submitted += step
            if course_id:                       # 前端每次上报后都会重算该课进度
                self.progress_update(course_id)
            if isinstance(body, dict) and body.get("finishStatus") in DONE_FINISH:
                stats["submitted"] = submitted
                return True, f"完成, 共 {rounds} 轮 / {submitted}s"
            self._sleep(random.uniform(0.6, 1.6))

        # 复核
        stats["submitted"] = submitted
        return False, f"轮次用完仍未见完成 (已提交 {submitted}s)"

    # ------------------------------------------------------------ 批量执行
    def run_course(self, course_id, only_unfinished=True, depth=0, sync_only=False,
                   budget=None, report=None):
        """budget=本次可提交秒数（None=不限）; report 收 ok/fail/submitted/partial。"""
        det, secs = self.open_course(course_id)
        library = bool(det.get("_library"))
        self.say(f"\n===== {det.get('name')} =====")
        self.say(f"小节 {len(secs)} 个 | 已报名 {det.get('register')} | "
              f"模式 {self.mode} | 单档 {self.chunk}s")
        todo = [s for s in secs if s["finish"] not in DONE_FINISH] if only_unfinished else secs
        if sync_only:
            todo = [s for s in todo if s["type"] == NESTED_TYPE]
            self.say(f"[sync] 只复核关联课程父记录 {len(todo)} 个\n")
        else:
            self.say(f"待处理 {len(todo)} 个\n")

        ok = fail = 0
        touched = set()
        used_sec = 0.0        # 本课已提交秒数（预算口径）
        partial = False
        for i, sec in enumerate(todo, 1):
            if budget is not None and used_sec >= budget:
                partial = True                # 额度已用满, 本课不再继续
                break
            tag = TYPE_NAME.get(sec["type"], sec["type"])
            self.say(f"[{i}/{len(todo)}] ({tag}) {sec['name'][:38]}")
            try:
                if sync_only:
                    good = self.settle_nested(course_id, sec["resource_id"], sec["section_id"])
                    msg = "父记录已判完成" if good else "平台仍未判定"
                else:
                    st = {}
                    good, msg = self.fake_section(sec, depth=depth,
                                                  parent_course_id=course_id,
                                                  course_id=course_id, library=library,
                                                  stats=st,
                                                  budget=None if budget is None
                                                  else budget - used_sec)
                    used_sec += float(st.get("submitted") or 0)
                    if st.get("partial"):
                        partial = True
            except BotStopped:
                raise
            except QuotaExhausted:
                self.say("[配额] 当日学时配额已满, 终止本课程剩余小节")
                raise
            except Exception as e:
                good, msg = False, f"异常 {type(e).__name__}: {e}"
            self.say(f"         -> {'OK' if good else 'FAIL'} {msg}")
            ok += good
            fail += (not good)
            if good:
                touched.add(sec["section_id"])
            if not self.dry_run:
                self._sleep(random.uniform(2.0, 5.0))

        if partial:
            self.say("[额度] 已达本次学时上限, 停在半节上（下次续学即可, 不要当失败重跑）")

        # 复核：先刷新进度行，再把本次处理过却回退的小节补 settle 一次
        def snapshot():
            self.sync_sections(course_id)
            return self.sections(course_id, det.get("versionId", ""),
                                 det.get("register", False))

        secs2 = snapshot() if not self.dry_run else self.sections(
            course_id, det.get("versionId", ""), det.get("register", False))
        back = [s for s in secs2
                if s["section_id"] in touched and s["finish"] not in DONE_FINISH]
        if back and not self.dry_run and not sync_only:
            self.say(f"\n[修复] {len(back)} 个本次已处理的小节回退到未完成，重新 settle")
            for s in back:
                if s["type"] == NESTED_TYPE:
                    good = self.settle_nested(course_id, s["resource_id"], s["section_id"],
                                              confirm=self.nest_confirm)
                else:
                    good, _ = self.fake_section(s, depth=depth, parent_course_id=course_id,
                                                course_id=course_id, library=library)
                self.say(f"         {'✅' if good else '⏳'} {s['name'][:30]}")
            try:
                secs2 = snapshot()
            except Exception as exc:      # 回读失败沿用修复前读数，别判失败
                self.say(f"[修复] 回读失败，沿用原结果：{exc}")

        done = sum(1 for s in secs2 if s["finish"] in DONE_FINISH)
        self.say(f"\n结果: 成功 {ok} / 失败 {fail} | 小节完成度 {done}/{len(secs2)}")
        self.last_result = {"done": done, "total": len(secs2), "failed": fail,
                            "confirmed": None}
        if report is not None:
            report.update({"ok": ok, "fail": fail, "submitted": used_sec,
                           "partial": partial})
        # 本次没有失败就等服务端把这一课汇总完 —— 两处都不能省：
        # 1) 不看 done==total：小节回读会滞后/回退，当"没学完"会导致重复学习、白扣配额；
        # 2) 不看 todo 非空：--sync / 重跑到"小节早就全部完成、只差专题层汇总"时 todo 是空的，
        #    此时正是最需要轮询专题完成态的场景。
        if not self.dry_run and fail == 0 and secs2 and (todo or done == len(secs2)):
            self.say(f"[复核] 等待平台异步汇总（最多 {self.wait_sync}s）…")
            self.last_result["confirmed"] = self.wait_finish(course_id)
            if self.last_result["confirmed"]:
                # 平台汇总后回读一次：父课程据此拿到最新计数，否则会误报"子课程未完成"。
                # 这次回读是**尽力而为**：它失败不能把已经确认完成的课程改成失败。
                try:
                    secs2 = self.sections(course_id, det.get("versionId", ""),
                                          det.get("register", False))
                    done = sum(1 for x in secs2 if x["finish"] in DONE_FINISH)
                    self.last_result["done"] = done
                    self.say(f"[复核] 汇总后回读：小节完成度 {done}/{len(secs2)}")
                except Exception as exc:
                    self.say(f"[复核] 汇总后回读失败（保留已确认结果）：{exc}")
        return done, len(secs2)

    def course_finish(self, course_id):
        """课程/专题层完成态 finishStatus（只读，不消耗学习配额）。"""
        _, body = self._req("GET", API_COURSE_INFO, params={"ids": course_id})
        if isinstance(body, list) and body:
            return body[0].get("finishStatus")
        return None

    def sync_sections(self, course_id, secs=None):
        """对齐前端 updateCourseProgress：一次提交该课全部小节 resourceIds。

        前端每次进入课程/专题页都发；平台据此刷新小节进度行。
        """
        if secs is None:
            _, secs = self.open_course(course_id)
        ids = ",".join(s["resource_id"] for s in secs if s.get("resource_id"))
        if not ids:
            return None
        return self._req("POST", API_SECTION_PROGRESS,
                         data={"courseId": course_id, "resourceIds": ids})

    def progress_update(self, course_id):
        """对齐前端 commitProgressUpdate：上报后让平台重算该课进度。

        只刷新进度条/剩余时长，**不影响完成态写入**（那一步是服务端异步结算）。
        """
        return self._req("POST", API_PROGRESS_UPD,
                         data={"encrypt": "false", "courseId": course_id})

    def wait_finish(self, course_id, timeout=None, interval=30, deadline=None):
        """只读轮询，等服务端把课程/专题置为完成。返回是否完成。

        完成态由服务端异步结算写入，客户端请求无法触发（实测 2026-11-05：
        course-progress-update 四种参数变体 + 批量 course-section-progress 均返回
        success 但状态不变）。观测延迟 2–18 分钟，同批对象常在同一毫秒批量落库
        （354 条已完成记录里 80 条如此），所以只能等，不能靠补请求保证立即完成。

        deadline: 共享截止时刻（run_todo 里多个课程共用一份时间预算）。
        """
        timeout = self.wait_sync if timeout is None else timeout
        if self.dry_run:
            return self.course_finish(course_id) in DONE_FINISH
        t0 = time.time()
        if deadline is None:
            if timeout <= 0:
                return self.course_finish(course_id) in DONE_FINISH
            deadline = t0 + timeout
        while True:
            if self.stopped():
                raise BotStopped()
            try:
                finished = self.course_finish(course_id) in DONE_FINISH
            except Exception as exc:            # 单次网络抖动不该让整门课判失败
                self.say(f"[复核] 查询失败 {type(exc).__name__}: {exc}")
                finished = False
            if finished:
                waited = int(time.time() - t0)
                if waited:
                    self.say(f"[复核] 平台已完成汇总（等待 {waited}s）")
                return True
            if time.time() >= deadline:
                break
            self._sleep(min(interval, max(1.0, deadline - time.time())))
        self.say(f"[复核] 平台尚未汇总（已等 {int(time.time() - t0)}s）；"
                 f"服务端异步结算实测需 2–18 分钟，稍后可用 --sync 复查，不必重新学")
        return False

    def stop(self):
        """请求停止全部学习循环（close 也会触发）; 已在路上的单次 HTTP 不强行中断。"""
        self._stop.set()

    def stopped(self):
        return self._stop.is_set()

    def _sleep(self, seconds):
        """可中断等待: 期间收到停止请求最迟 0.5s 后抛 BotStopped, 上层直接收尾。

        用 time.sleep 分片而不是 Event.wait: 测试会把 time.sleep 打桩成假钟,
        绕过它会让等待变成真实时长, 用例会挂。
        """
        left = max(0.0, seconds)
        while left > 0:
            if self._stop.is_set():
                raise BotStopped()
            piece = min(0.5, left)
            time.sleep(piece)
            left -= piece

    def close(self):
        self._stop.set()          # close 即停: 学习循环最迟在下一个等待点退出
        if self.hb:
            self.hb.stop()
            self.say(f"[心跳] 共发送 {self.hb.beats} 次 PING")
            self.hb.join(timeout=1)   # 心跳线程 recv 自带 10s 超时, 这里不无限等

    # ------------------------------------------------------------ 目标解析
    UUID_RE = re.compile(
        r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|[0-9a-f]{32}", re.I)

    def hours_self(self):
        """网络自学/集中培训学时账本 (hourSelf / hourTrain / requireClassHour)。"""
        _, body = self._req("GET", API_DETAIL_HOUR)
        return body or {}

    def course_logs(self, business_type: int = 0, days: int = 7) -> list[dict]:
        """学习记录：最近 N 天的课程/专题访问（beginTime/lastAccessTime/累计时长）。"""
        now = int(time.time() * 1000)
        start = now - max(1, days) * 86400 * 1000
        out, page = [], 1
        while True:
            _, body = self._req("GET", API_COURSELOG, params={
                "businessType": business_type, "startTime": start, "endTime": now,
                "page": page, "pageSize": 100})
            items = (body or {}).get("items") or []
            out.extend(items)
            total = int((body or {}).get("recordCount") or 0)
            if not items or len(out) >= total:
                return out
            page += 1

    def search_courses(self, keyword: str, page_size: int = 20) -> list[dict]:
        """搜索平台课程库（含未加入"我的任务/我的课程"的课程与专题）。

        type: 0=课程, 2=专题（实测 2026-11-05）；publishClient=1 必填，缺则 422。
        """
        out = []
        for kind_type, kind_name in ((0, "课程"), (2, "专题")):
            page = 1
            while True:                               # 翻页取全（命中数常超过单页上限）
                _, body = self._req("GET", API_GLOBAL_SEARCH, params={
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

    def resolve_course(self, arg):
        """把 课程/专题 的 URL、名称(模糊) 或 id 解析成 (businessId, name)。

        支持: 完整 URL (自动提取其中 uuid) / 32 位 uuid / 名称模糊匹配
        (先在"我的任务"里找, 未完成优先)。
        """
        arg = (arg or "").strip()
        m = self.UUID_RE.search(arg)
        if m:
            return m.group(0), None
        items = self.list_tasks()
        low = arg.lower()
        cands = [t for t in items if low in (t.get("name") or "").lower()]
        if not cands:
            raise SystemExit(f"任务列表中没有名称含 {arg!r} 的课程/专题, "
                             f"先 --list 看看有什么")
        undone = [t for t in cands if t["status"] in TASK_UNDONE]
        pool = undone or cands
        if len(pool) > 1:
            self.say(f"[匹配] 名称命中 {len(pool)} 个, 取第一个:")
            for t in pool[:5]:
                mark = "已完成" if t["status"] == TASK_DONE else "未完成"
                self.say(f"         ({mark}) {t['name'][:40]}")
        t = pool[0]
        return t["businessId"], t.get("name")

    # ------------------------------------------------------------ 批量执行(任务级)
    def undone_tasks(self):
        """我的任务中未完成的课程/专题 (不含考试/调研/班级/直播)。

        任务接口的 status 有时滞后于小节：小节已到完成态(2/4)而任务仍报 1，
        故再用 finishStatus 拦一道（字段不存在时退化为只看 status）。
        """
        return [t for t in self.list_tasks()
                if t["status"] in TASK_UNDONE and t["businessType"] in (1, 2)
                and t.get("finishStatus") not in DONE_FINISH
                and not t.get("expired")]          # 过期任务不自动学（白耗配额）

    def person_courses(self, business_type):
        """我的课程/专题列表 (含必修选修与学习状态)。

        business_type: 0=课程, 2=专题
        返回 [{bid, name, required, finish, state}]
        finishStatus: 0=未开始, 1=学习中, 2=已完成(复习), 4=已完成
        """
        state_name = FINISH_NAME
        # 一次拉全量 (pageSize=500 实测可全), 避免按最近访问排序时分页漂移
        _, body = self._req("GET", API_PERSON_COURSE, params={
            "page": 1, "pageSize": 500, "findStudy": 0,
            "businessType": business_type, "studyTimeOrder": "desc",
            "finishStatus": "", "isRequired": ""})
        items = (body or {}).get("items") or []
        out, seen = [], set()
        for it in items:
            bid = it.get("courseId")
            if not bid or bid in seen:      # 去重, 防服务端分页抖动
                continue
            seen.add(bid)
            ci = it.get("courseInfo") or {}
            fin = it.get("finishStatus", 0)
            out.append({
                "bid": bid,
                "name": ci.get("name") or "",
                "required": "必修" if it.get("isRequired") == 1 else "选修",
                "finish": fin,
                "state": state_name.get(fin, str(fin)),
                "reg_ts": it.get("registerTime") or 0,      # 注册学习时间
                # 注意: 不使用 lastAccessTime —— 它是"上次访问时间", 任何 API
                # 调用(含本工具的补算/详情)都会改写, 数据已污染
                "url": ci.get("url") or f"{BASE}home?courseId={bid}",
            })
        return out

    def all_view_items(self):
        """TUI/清单用的统一视图: 全部类型 + 三态 + 必修/选修。

        返回 [{type, required, state, name, bid, runnable}]
        """
        rows = []
        for it in self.person_courses(0):
            rows.append({"type": "课程", "required": it["required"],
                         "state": it["state"], "name": it["name"],
                         "bid": it["bid"], "runnable": it["finish"] not in DONE_FINISH,
                         "reg_ts": it["reg_ts"],
                         "push_ts": it["reg_ts"], "url": it["url"]})
        for it in self.person_courses(2):
            rows.append({"type": "专题", "required": it["required"],
                         "state": it["state"], "name": it["name"],
                         "bid": it["bid"], "runnable": it["finish"] not in DONE_FINISH,
                         "reg_ts": it["reg_ts"],
                         "push_ts": it["reg_ts"], "url": it["url"]})
        now_ms = time.time() * 1000
        tname = {3: "考试", 4: "调研", 5: "班级", 6: "直播"}
        for t in self.list_tasks():
            if t["businessId"] in {r["bid"] for r in rows}:
                continue                    # 课程/专题已覆盖, 去重
            bt = t["businessType"]
            if bt in (1, 2):        # 课程/专题已在上面, 避免重复
                continue
            if t["status"] == TASK_DONE:
                state = "已完成"
            elif t.get("expired"):
                state = "已过期"
            elif t["status"] == 2:
                state = "学习中"
            else:
                state = "未开始" if (t.get("startTime") or 0) > now_ms else "学习中"
            rows.append({"type": tname.get(bt, str(bt)), "required": "—",
                         "state": state, "name": t.get("name") or "",
                         "bid": t["businessId"], "runnable": False,
                         "reg_ts": 0,
                         "push_ts": t.get("createTime") or 0,
                         "url": t.get("url") or ""})
        return rows

    def run_todo(self):
        """完成"我的任务"中全部未完成/未开始的课程与专题。

        未到开始时间(startTime 在未来)的任务跳过; 配额满时立即停止全部处理。
        """
        items = self.undone_tasks()
        now_ms = time.time() * 1000
        future = [t for t in items if (t.get("startTime") or 0) > now_ms]
        if future:
            items = [t for t in items if t not in future]
            self.say(f"[todo] {len(future)} 个任务未到开始时间, 跳过:")
            for t in future[:5]:
                self.say(f"         - {t['name'][:40]}")
        self.say(f"[todo] 待处理 {len(items)} 个\n")
        summary = []
        # 批量跑不逐个等汇总（每个都等几分钟会卡死）；收尾统一只读复核
        saved_wait, self.wait_sync = self.wait_sync, 0
        try:
            for i, t in enumerate(items, 1):
                self.say(f"\n########## 任务 [{i}/{len(items)}] {t['name'][:40]} ##########")
                try:
                    done, total = self.run_course(t["businessId"])
                except BotStopped:
                    raise
                except QuotaExhausted:
                    self.say("[todo] ⛔ 当日学时配额已满, 停止处理剩余任务, 请次日重跑")
                    break
                except Exception as e:
                    done, total = 0, 0
                    # 上一门课的 last_result 不能留到这里，否则失败的课会被记成 ✅/⏳
                    self.last_result = {"done": 0, "total": 0, "failed": 1,
                                        "confirmed": None}
                    self.say(f"         -> FAIL 异常 {type(e).__name__}: {e}")
                summary.append((t["name"], done, total, t["businessId"],
                                dict(self.last_result)))
        finally:
            self.wait_sync = saved_wait
        # 学完了（本次无失败）但专题层还没汇总的，统一只读复核，共用一份时间预算
        pending = [(n, b) for n, d, t, b, r in summary
                   if r.get("failed") == 0 and r.get("confirmed") is not True and t]
        if pending and not self.dry_run and self.wait_sync:
            self.say(f"\n[复核] {len(pending)} 个课程/专题等待平台异步汇总"
                     f"（共享 {self.wait_sync}s 预算）…")
            deadline = time.time() + self.wait_sync
            while pending and time.time() < deadline:
                still = []
                for name, bid in pending:
                    try:
                        finished = self.course_finish(bid) in DONE_FINISH
                    except Exception as exc:      # 网络抖动不该让汇总整体崩掉
                        self.say(f"[复核] 查询失败 {type(exc).__name__}: {exc}")
                        still.append((name, bid))
                        continue
                    if finished:
                        self.say(f"  ✅ {name[:40]}")
                        for i, (n, _d, _t, b, r) in enumerate(summary):
                            if b == bid:
                                summary[i] = (n, _d, _t, b, {**r, "confirmed": True})
                    else:
                        still.append((name, bid))
                pending = still
                if pending:
                    self._sleep(min(30, max(1.0, deadline - time.time())))
        self.say("\n========== 汇总 ==========")
        for name, done, total, _bid, r in summary:
            if r.get("failed"):
                flag = "⚠️ "
            elif r.get("confirmed") is True:
                flag = "✅"
            elif r.get("confirmed") is False:
                flag = "⏳"                      # 学完了, 平台还没汇总 —— 不是失败
            else:
                flag = "✅" if done == total and total else "⚠️ "
            self.say(f"{flag} {done}/{total}  {name[:40]}")
        if any(r.get("confirmed") is False for *_x, r in summary):
            self.say("（⏳ = 学习已完成，平台汇总要 2–18 分钟；不要重跑，会白扣配额）")

    def run_hours(self, target="auto"):
        """刷够"网络自学"指定学时 (小时数)。

        学时账本字段: hourSelf=网络自学已得学时, requireCourseHour=网络自学要求
        (注意 requireClassHour=90 是另一口径, 不是网络自学的线)。
        target='auto' 时自动补齐 requireCourseHour - hourSelf 的差额。
        """
        info = self.hours_self()
        base = float(info.get("hourSelf") or 0)
        req = float(info.get("requireCourseHour") or 0)
        req_class = info.get("requireClassHour")
        if target in (None, "auto"):
            target = max(0.0, req - base)
        target = float(target)
        self.say(f"[学时] 网络自学 {base:.1f} / 要求 {req:.1f} 学时"
              f" (口径参考: requireClassHour={req_class})"
              f" | 目标: 再刷 {target:.2f} 学时\n")
        if target <= 0:
            self.say("[学时] ✅ 网络自学已达标, 无需再刷")
            return
        items = self.undone_tasks()
        if not items:
            self.say("[学时] 没有 未完成 的课程/专题可供刷学时")
            return
        gained = 0.0
        flat = 0  # 连续两门课学时无增长 → 疑似配额/口径问题, 停
        budget = target * 3600.0        # 本次额度（秒）: 到点停在半节, 不是整门跑完才查
        local_sec = 0.0                 # 本地已提交秒数（平台口径滞后, 先用它熔断）
        if not self.dry_run:
            # 先按学习前读数建当日基准: 否则中途退出/异常时不落账,
            # 同日重跑 --today 会把已学过的量再给一遍
            record_today_hours(base, session_base=base)
        try:
            for i, t in enumerate(items, 1):
                if budget - local_sec <= 1:
                    self.say("[学时] 本次学时额度已用满, 停止处理")
                    break
                if self.stopped():
                    raise BotStopped()
                self.say(f"\n########## 学时任务 [{i}/{len(items)}] {t['name'][:40]} ##########")
                rep = {}
                try:
                    self.run_course(t["businessId"],
                                    budget=max(1.0, budget - local_sec), report=rep)
                except BotStopped:
                    raise
                except QuotaExhausted:
                    self.say("[学时] ⛔ 当日学时配额已满, 停止处理, 请次日重跑")
                    return
                except Exception as e:
                    self.say(f"         -> FAIL 异常 {type(e).__name__}: {e}")
                    continue
                local_sec += float(rep.get("submitted") or 0)
                if rep.get("partial"):
                    self.say("[学时] 已达本次学时额度, 停在半节上（下次续学, 不要当失败重跑）")
                    break
                info = self.hours_self()
                gained = float(info.get("hourSelf") or 0) - base
                self.say(f"[学时] 已累计 本地 {local_sec / 3600:.2f}h"
                      f" / 平台 +{gained:.2f}/{target} 学时")
                if gained >= target:
                    self.say(f"[学时] 🎉 已达成目标: +{gained:.2f} 学时")
                    return
                flat = flat + 1 if gained <= 0 else 0
                if flat >= 2:
                    self.say("[学时] ⛔ 连续两门课后学时无增长——"
                          "大概率当日配额已满或学时入账有延迟, 停止")
                    return
        finally:
            # 无论走完、达标提前退还是异常中断, 都按最新读数落账一次
            if not self.dry_run:
                try:
                    record_today_hours(float(self.hours_self().get("hourSelf") or 0),
                                       session_base=base)
                except Exception as e:
                    self.say(f"[今日] 落账失败（{type(e).__name__}: {e}）, 不影响已上报时长")
        self.say(f"[学时] 未完成任务全部刷完, 累计 +{gained:.2f}/{target} 学时"
              f" (新任务可能明天才出现)")


# ---------------------------------------------------------------- CLI

def resolve_user(arg):
    """把 --user 解析成账号 key: 匹配 备注名/用户名/平台真实姓名, 支持前缀。"""
    import mooc_api_login as m
    if not arg:
        return None
    accounts = m.list_accounts()
    if not accounts:
        raise SystemExit("还没有配置任何账号: 复制 .env.example 为 .env 并填入账密, "
                         "或用 `python mooc_api_login.py add 用户名 密码` 添加")
    exact = [a["key"] for a in accounts
             if arg in (a["key"], a["username"], a.get("display_name"))]
    if exact:
        return exact[0]
    pref = []
    for a in accounts:
        for c in (a["key"], a["username"], a.get("display_name")):
            if c and c.startswith(arg):
                pref.append(a["key"])
                break
    pref = list(dict.fromkeys(pref))
    if len(pref) == 1:
        return pref[0]
    names = [f"{a['key']}({a.get('display_name') or a['username']})" for a in accounts]
    if len(pref) > 1:
        raise SystemExit(f"账号前缀 {arg!r} 命中多个: {pref}; 请写得更具体")
    raise SystemExit(f"账号 {arg!r} 不存在; 可用: {names}")


def cmd_list(bot):
    say = bot.say
    items = bot.list_tasks()
    now_ms = time.time() * 1000
    undone = [t for t in items if t["status"] in TASK_UNDONE
              and t.get("finishStatus") not in DONE_FINISH]
    names = {1: "课程", 2: "专题", 3: "考试", 4: "调研", 5: "班级", 6: "直播"}
    info = bot.hours_self()
    say(f"网络自学 {info.get('hourSelf', 0)} / 要求 {info.get('requireCourseHour', 0)} 学时"
          f" | 集中培训 {info.get('hourTrain', 0)} 学时\n")
    say(f"未完成任务 {len(undone)} / 共 {len(items)}\n")
    for t in undone:
        state = "未开始" if (t.get("startTime") or 0) > now_ms else "未完成"
        say(f"[{names.get(t['businessType'], t['businessType'])}|{state}] "
              f"{t['name'][:44]:46s} {t['businessId']}")


def main():
    ap = argparse.ArgumentParser(description="自动伪造心跳刷满学时")
    ap.add_argument("--course", metavar="目标",
                    help="课程/专题: 支持业务id、名称(模糊)或页面 URL")
    ap.add_argument("--todo", "--all", dest="all", action="store_true",
                    help="完成\"我的任务\"中全部 未完成/未开始 的课程与专题")
    ap.add_argument("--hours", metavar="学时", default=None,
                    help="刷够\"网络自学\"指定学时; 省略值或 auto=自动补齐到要求线")
    ap.add_argument("--list", action="store_true", help="列出未完成任务与学时进度")
    ap.add_argument("--sync", action="store_true",
                    help="只复核关联课程父小节(子课程已完成但专题仍显示未完成时用)")
    ap.add_argument("--today", action="store_true",
                    help="只学今天该学的量（按工作档位容量与学时缺口取小，同日重跑不重复给额度）")
    ap.add_argument("--search", metavar="关键词",
                    help="搜索平台课程库（含未加入任务的课程/专题）")
    ap.add_argument("--logs", metavar="天数", type=int, nargs="?", const=7, default=None,
                    help="学习记录：最近 N 天学过/在学的课程与专题（默认 7 天）")
    ap.add_argument("--ics", metavar="文件",
                    help="把必修截止日导出为 iCalendar 日历文件（含提前 3 天提醒）")
    ap.add_argument("--force", action="store_true",
                    help="--ics 目标文件已存在时也允许覆盖")
    ap.add_argument("--dry-run", action="store_true", help="只体检不上报")
    ap.add_argument("--chunk", type=int, default=None,
                    help="单次上报秒数 (音频默认300, 视频默认600)")
    ap.add_argument("--mode", choices=("auto", "audio", "video"), default="auto",
                    help="auto=优先 mp3 音轨, audio=强制音频模式, video=只用 mp4")
    ap.add_argument("--no-ws", action="store_true", help="不建立心跳 WebSocket")
    ap.add_argument("--wait-sync", type=int, default=1200, metavar="秒",
                    help="课程学完后等服务端异步汇总完成态的时间 (默认 1200, 0=不等)")
    ap.add_argument("--no-wait", action="store_true", help="不等汇总 (等同 --wait-sync 0)")
    ap.add_argument("--user", metavar="账号", default=None,
                    help="多账号: 选择 accounts.json 中的账号名 (支持前缀)")
    ap.add_argument("--tui", "-t", action="store_true",
                    help="打开交互界面（等价于 python mooc_tui.py），按钮/鼠标均可操作")
    a = ap.parse_args()

    if a.tui:                                  # 统一入口: 同一个命令进界面
        from mooc_tui import StudyTUI
        StudyTUI(mode=a.mode, dry_run=a.dry_run, user=a.user).run()
        return

    user = resolve_user(a.user)
    import mooc_client
    mooc_client.set_user(user)
    print(f"[账号] {user or 'default'}")
    bot = StudyBot(dry_run=a.dry_run, chunk=a.chunk, ws=not a.no_ws, mode=a.mode,
                   wait_sync=0 if a.no_wait else a.wait_sync)
    try:
        if a.search:
            rows = bot.search_courses(a.search)
            print(f"[搜索] 「{a.search}」命中 {len(rows)} 条（平台课程库，含未加入任务的）")
            for r in rows[:20]:
                print(f"  [{r['kind']}] {r['name'][:44]:46s} {r['courseHour']:>5.1f} 学时  {r['id']}")
            if not (a.course or a.todo or a.today or a.hours is not None):
                print(f"RESULT|ok=true|mode=search|found={len(rows)}")
                return
        if a.logs is not None:
            merged = {}
            for r in bot.course_logs(0, a.logs) + bot.course_logs(2, a.logs):
                merged[r.get("id")] = r          # businessType 0/2 会重叠
            rows = sorted(merged.values(),
                          key=lambda r: r.get("lastAccessTime") or 0, reverse=True)
            print(f"[记录] 最近 {a.logs} 天：{len(rows)} 条")
            for r in rows[:40]:
                import datetime as _dt
                la = r.get("lastAccessTime")
                ts = _dt.datetime.fromtimestamp(la / 1000).strftime("%m-%d %H:%M") if la else "  —  "
                name = (r.get("courseInfo") or {}).get("name") or ""
                fs = r.get("finishStatus")
                state = ("已学完" if fs in DONE_FINISH
                         else {0: "未开始", 1: "学习中"}.get(fs, str(fs)))
                print(f"  {ts}  {state:4s}  {(r.get('studyTotalTime') or 0) / 3600:5.2f}h  {name[:40]}")
            print(f"RESULT|ok=true|mode=logs|count={len(rows)}")
            return 0
        if a.ics:
            # 限制为 .ics 后缀, 防止把导出当写文件原语覆盖任意文件
            if not str(a.ics).lower().endswith(".ics"):
                print("[ics] 目标必须以 .ics 结尾")
                return 2
            target = pathlib.Path(a.ics)
            if target.exists() and not a.force:
                print(f"[ics] {a.ics} 已存在; 如确要覆盖, 加 --force")
                return 2
            items = [t for t in bot.list_tasks()
                     if t.get("businessType") in (1, 2) and not t.get("expired")]
            target.write_text(render_ics(items, alarm_days=3), encoding="utf-8")
            print(f"[ics] 已导出 {len(items)} 个必修截止日到 {a.ics}")
            return 0
        if a.today:
            info = bot.hours_self()
            got = float(info.get("hourSelf") or 0)
            need = float(info.get("requireCourseHour") or 0)
            cap, prof = _today_capacity()
            used = today_used(got)
            quota = min(max(0.0, cap - used), max(0.0, need - got))
            print(f"[今日] 档位「{prof.get('label') or '默认'}」｜今日容量 {cap:.2f} 学时"
                  f"｜今天已学 {used:.2f}｜剩余额度 {max(0.0, cap - used):.2f}"
                  f"｜网络自学 {got:.2f}/{need:.2f}，缺口 {max(0.0, need - got):.2f}")
            if quota <= 0:
                print("[今日] ✅ 今天不用再学（容量已用满或学时已达标）")
                return 0
            print(f"[今日] 今天的目标 {quota:.2f} 学时，学完即停")
            a.hours = str(round(quota, 2))
        if a.hours is not None:
            bot.run_hours(a.hours if a.hours else "auto")
            return
        if a.list or not (a.course or a.all):
            cmd_list(bot)
            if not a.course and not a.all:
                return
        if a.all:
            bot.run_todo()
        elif a.course:
            cid, name = bot.resolve_course(a.course)
            if name:
                print(f"[匹配] {name}")
            bot.run_course(cid, sync_only=a.sync)
    finally:
        bot.close()


if __name__ == "__main__":
    main()
