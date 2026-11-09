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
import random
import re
import sys
import threading
import time

import requests

from mooc_client import BASE, fresh_token, load_token_safe
from mooc_ws import WSClient, WSClosed

# 小节类型 (module-study 内 sectionTypes)
TYPE_NAME = {1: "pdf", 2: "image", 3: "url", 4: "scorm", 5: "mp3", 6: "mp4",
             7: "epub", 8: "task", 9: "exam", 10: "other", 12: "survey",
             13: "assessment", 15: "kj"}
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
WS_URL = "wss://mooc.ctt.cn/api/v1/course-study/ws/course?token="


# ---------------------------------------------------------------- 心跳线程

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


class StudyBot:
    def __init__(self, verbose=True, dry_run=False, chunk=None, ws=True, mode="auto", say=None):
        self.say = say or print
        self.verbose = verbose
        self._auth_lock = threading.Lock()     # 仅保护 token 重登
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

    def open_course(self, course_id):
        _, det = self._req("POST", API_REGISTER, data={"courseId": course_id})
        det = det or {}
        secs = self.sections(course_id, det.get("versionId", ""), det.get("register", False))
        return det, secs

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
    def _start(self, section_id, backdate_s):
        """创建学习日志; createTime 回溯 backdate_s 秒 → 放宽时长校验。"""
        now_ms = int(time.time() * 1000)
        ct = now_ms - int(backdate_s * 1000)
        code, body = self._req("GET", f"{API_START}/{section_id}",
                               params={"clientType": 1, "createTime": ct})
        if code != 200 or not isinstance(body, dict) or not body.get("id"):
            return None, None
        return body["id"], body.get("remainingTime")

    def _commit_video(self, log_id, study, loc, total):
        return self._req("POST", API_VIDEO, data={
            "encrypt": "false", "logId": log_id, "studyTime": int(study),
            "lessonLocation": int(loc), "resourceTotalTime": int(total),
            "flush": "false"})

    def _commit_doc(self, log_id, loc=None):
        d = {"encrypt": "false", "logId": log_id}
        if loc is not None:
            d["lessonLocation"] = int(loc)
        return self._req("POST", API_DOC, data=d)

    def settle_nested(self, parent_course_id, child_course_id, section_id, tries=4):
        """关联课程父小节: 子课程完成后, 让平台把父记录判为已完成。

        实测要点:
          1. 父记录需要先存在 —— POST course-front/course-section-progress
             (form: courseId=专题, resourceIds=子课程id) 会创建一条 sectionType=10 的进度行
          2. 之后 start-progress + doc-progress 打心跳: 第一次置 1(学习中)
          3. 平台核对子课程完成后置 2, 该步为异步, 可能需重试或稍后再来
        """
        # 1. 建/取父记录
        self._req("POST", API_SECTION_PROGRESS,
                  data={"courseId": parent_course_id, "resourceIds": child_course_id})

        # 2. 心跳 + 轮询
        for i in range(tries):
            log_id, _ = self._start(section_id, 3600)
            if log_id:
                code, body = self._commit_doc(log_id)
                if isinstance(body, dict) and body.get("finishStatus") == 2:
                    return True
            time.sleep(random.uniform(2.5, 4.0))

        # 3. 复核一次
        code, rows = self._req("POST", API_SECTION_PROGRESS,
                               data={"courseId": parent_course_id,
                                     "resourceIds": child_course_id})
        if isinstance(rows, list) and rows:
            return rows[0].get("finishStatus") == 2
        return False

    def fake_section(self, sec, chunk=None, depth=0, parent_course_id=None):
        """把单个小节刷到 finishStatus=2。返回 (成功?, 说明)。"""
        chunk = chunk or self.chunk
        sid, stype = sec["section_id"], sec["type"]
        name = (sec["name"] or "")[:40]

        if stype in SKIP_TYPES:
            return False, f"类型 {TYPE_NAME.get(stype, stype)} 需真实作答, 跳过"
        if sec["finish"] == 2:
            return True, "已完成, 跳过"

        # 关联课程: 递归刷子课程, 再用心跳提交把父小节判为已完成
        if stype == NESTED_TYPE:
            if depth >= MAX_DEPTH:
                return False, "嵌套过深, 跳过"
            self.say(f"         ↳ 关联课程 {sec['resource_id']}")
            done, total = self.run_course(sec["resource_id"], depth=depth + 1)
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
            _, rem = self._start(sid, 3600)
            return False, (f"[dry-run] 剩余 {rem}s | {TYPE_NAME.get(stype, stype)}"
                           f"{' | ' + audio_note if audio_note else ''}")

        total = None
        rounds = 0
        submitted = 0
        prev_rem = None
        stuck = 0
        for _ in range(60):
            rounds += 1
            # 每次上报都需要一条新日志: 先取剩余时长, 同时回溯 createTime
            log_id, rem = self._start(sid, chunk + random.randint(60, 300))
            if log_id is None:
                return False, "start-progress 失败"
            if rem is None:
                rem = 0
            if rem <= 0:
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
            loc = min(total, total - rem + step)

            if stype in MEDIA_TYPES:
                code, body = self._commit_video(log_id, step, loc, total)
            else:
                code, body = self._commit_doc(log_id, loc)

            if code != 200:
                # 40909: 日志已用尽/失效 → 换一条再来
                if isinstance(body, dict) and body.get("errorCode") == 40909:
                    time.sleep(1)
                    continue
                return False, f"上报失败 HTTP {code} {body}"

            submitted += step
            if isinstance(body, dict) and body.get("finishStatus") == 2:
                return True, f"完成, 共 {rounds} 轮 / {submitted}s"
            time.sleep(random.uniform(0.6, 1.6))

        # 复核
        return False, f"轮次用完仍未见完成 (已提交 {submitted}s)"

    # ------------------------------------------------------------ 批量执行
    def run_course(self, course_id, only_unfinished=True, depth=0, sync_only=False):
        det, secs = self.open_course(course_id)
        self.say(f"\n===== {det.get('name')} =====")
        self.say(f"小节 {len(secs)} 个 | 已报名 {det.get('register')} | "
              f"模式 {self.mode} | 单档 {self.chunk}s")
        todo = [s for s in secs if s["finish"] != 2] if only_unfinished else secs
        if sync_only:
            todo = [s for s in todo if s["type"] == NESTED_TYPE]
            self.say(f"[sync] 只复核关联课程父记录 {len(todo)} 个\n")
        else:
            self.say(f"待处理 {len(todo)} 个\n")

        ok = fail = 0
        for i, sec in enumerate(todo, 1):
            tag = TYPE_NAME.get(sec["type"], sec["type"])
            self.say(f"[{i}/{len(todo)}] ({tag}) {sec['name'][:38]}")
            try:
                if sync_only:
                    good = self.settle_nested(course_id, sec["resource_id"], sec["section_id"])
                    msg = "父记录已判完成" if good else "平台仍未判定"
                else:
                    good, msg = self.fake_section(sec, depth=depth,
                                                  parent_course_id=course_id)
            except QuotaExhausted:
                self.say("[配额] 当日学时配额已满, 终止本课程剩余小节")
                raise
            except Exception as e:
                good, msg = False, f"异常 {type(e).__name__}: {e}"
            self.say(f"         -> {'OK' if good else 'FAIL'} {msg}")
            ok += good
            fail += (not good)
            if not self.dry_run:
                time.sleep(random.uniform(2.0, 5.0))

        # 复核
        secs2 = self.sections(course_id, det.get("versionId", ""), det.get("register", False))
        done = sum(1 for s in secs2 if s["finish"] == 2)
        self.say(f"\n结果: 成功 {ok} / 失败 {fail} | 小节完成度 {done}/{len(secs2)}")
        return done, len(secs2)

    def close(self):
        if self.hb:
            self.hb.stop()
            self.say(f"[心跳] 共发送 {self.hb.beats} 次 PING")

    # ------------------------------------------------------------ 目标解析
    UUID_RE = re.compile(
        r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|[0-9a-f]{32}", re.I)

    def hours_self(self):
        """网络自学/集中培训学时账本 (hourSelf / hourTrain / requireClassHour)。"""
        _, body = self._req("GET", API_DETAIL_HOUR)
        return body or {}

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
        undone = [t for t in cands if t["status"] == 1]
        pool = undone or cands
        if len(pool) > 1:
            self.say(f"[匹配] 名称命中 {len(pool)} 个, 取第一个:")
            for t in pool[:5]:
                mark = "未完成" if t["status"] == 1 else "已完成"
                self.say(f"         ({mark}) {t['name'][:40]}")
        t = pool[0]
        return t["businessId"], t.get("name")

    # ------------------------------------------------------------ 批量执行(任务级)
    def undone_tasks(self):
        """我的任务中未完成的课程/专题 (不含考试/调研/班级/直播)。"""
        return [t for t in self.list_tasks()
                if t["status"] == 1 and t["businessType"] in (1, 2)]

    def person_courses(self, business_type):
        """我的课程/专题列表 (含必修选修与学习状态)。

        business_type: 0=课程, 2=专题
        返回 [{bid, name, required, finish, state}]
        finishStatus: 0=未开始, 1=学习中, 2=已完成
        """
        state_name = {0: "未开始", 1: "学习中", 2: "已完成", 4: "已完成"}
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
                         "bid": it["bid"], "runnable": it["finish"] != 2,
                         "reg_ts": it["reg_ts"],
                         "push_ts": it["reg_ts"], "url": it["url"]})
        for it in self.person_courses(2):
            rows.append({"type": "专题", "required": it["required"],
                         "state": it["state"], "name": it["name"],
                         "bid": it["bid"], "runnable": it["finish"] != 2,
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
            if t["status"] == 2:
                state = "已完成"
            elif t["status"] == 3:
                state = "已过期"
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
        for i, t in enumerate(items, 1):
            self.say(f"\n########## 任务 [{i}/{len(items)}] {t['name'][:40]} ##########")
            try:
                done, total = self.run_course(t["businessId"])
            except QuotaExhausted:
                self.say("[todo] ⛔ 当日学时配额已满, 停止处理剩余任务, 请次日重跑")
                break
            except Exception as e:
                done, total = 0, 0
                self.say(f"         -> FAIL 异常 {type(e).__name__}: {e}")
            summary.append((t["name"], done, total))
        self.say("\n========== 汇总 ==========")
        for name, done, total in summary:
            flag = "✅" if done == total and total else "⚠️ "
            self.say(f"{flag} {done}/{total}  {name[:40]}")

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
        for i, t in enumerate(items, 1):
            self.say(f"\n########## 学时任务 [{i}/{len(items)}] {t['name'][:40]} ##########")
            try:
                self.run_course(t["businessId"])
            except QuotaExhausted:
                self.say("[学时] ⛔ 当日学时配额已满, 停止处理, 请次日重跑")
                return
            except Exception as e:
                self.say(f"         -> FAIL 异常 {type(e).__name__}: {e}")
                continue
            info = self.hours_self()
            gained = float(info.get("hourSelf") or 0) - base
            self.say(f"[学时] 已累计 {gained:.2f}/{target} 学时")
            if gained >= target:
                self.say(f"[学时] 🎉 已达成目标: +{gained:.2f} 学时")
                return
            flat = flat + 1 if gained <= 0 else 0
            if flat >= 2:
                self.say("[学时] ⛔ 连续两门课后学时无增长——"
                      "大概率当日配额已满或学时入账有延迟, 停止")
                return
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
    undone = [t for t in items if t["status"] == 1]
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
    ap.add_argument("--dry-run", action="store_true", help="只体检不上报")
    ap.add_argument("--chunk", type=int, default=None,
                    help="单次上报秒数 (音频默认300, 视频默认600)")
    ap.add_argument("--mode", choices=("auto", "audio", "video"), default="auto",
                    help="auto=优先 mp3 音轨, audio=强制音频模式, video=只用 mp4")
    ap.add_argument("--no-ws", action="store_true", help="不建立心跳 WebSocket")
    ap.add_argument("--user", metavar="账号", default=None,
                    help="多账号: 选择 accounts.json 中的账号名 (支持前缀)")
    a = ap.parse_args()

    user = resolve_user(a.user)
    import mooc_client
    mooc_client.set_user(user)
    print(f"[账号] {user or 'default'}")
    bot = StudyBot(dry_run=a.dry_run, chunk=a.chunk, ws=not a.no_ws, mode=a.mode)
    try:
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
