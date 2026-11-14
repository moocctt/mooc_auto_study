#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
烟草网络学院 —— 我的任务 梳理 + 进入专题
==========================================
依赖 mooc_client (自动续期)。

功能:
  list_tasks()                 全量拉取"我的任务"
  classify(items)              按状态/类型分类 (未完成/未开始 x 课程/专题/考试/调研/班级/直播)
  enter_subject(business_id)   进入专题: POST register 报名+详情
                               → GET chapter-progress 章节(小节)树+完成状态
  main                         打印未完成/未开始清单, 并进入第一个在期未完成专题
"""

import datetime
import sys
import time

from mooc_client import api

TYPE_NAME = {1: "课程", 2: "专题", 3: "考试", 4: "调研", 5: "班级/培训班", 6: "直播"}
# status: 1=未开始/未完成, 2=进行中, 3=已完成（平台 UI 上显示“复习”）
# 过期不看 status —— 看独立的 expired 字段。
STATUS_NAME = {1: "未完成", 2: "进行中", 3: "已完成"}
TASK_UNDONE = (1, 2)


def _ts(ms, fmt="%Y-%m-%d"):
    if not ms:
        return "-"
    return datetime.datetime.fromtimestamp(ms / 1000).strftime(fmt)


def list_tasks():
    items, page = [], 1
    while True:
        out = api("GET", "api/v1/human/task",
                  params={"page": page, "pageSize": 50, "status": "", "filterAuthExam": 1})
        its = out.get("items") or []
        items += its
        total = out.get("recordCount", 0)
        if not its or len(items) >= total:
            break
        page += 1
    # 按 businessId 去重 (任务列表有重复返回)
    seen, uniq = set(), []
    for t in items:
        if t["id"] not in seen:
            seen.add(t["id"])
            uniq.append(t)
    return uniq


def classify(items, now_ms=None):
    now_ms = now_ms or time.time() * 1000
    undone = [t for t in items if t["status"] in TASK_UNDONE]
    return {
        "未开始": [t for t in undone if (t.get("startTime") or 0) > now_ms],
        "未完成": [t for t in undone if (t.get("startTime") or 0) <= now_ms],
        "已完成": [t for t in items if t["status"] == 3],
        "已过期": [t for t in items if t.get("expired")],
    }


def enter_subject(business_id):
    """进入专题: 报名+详情, 再拉章节树(含小节完成状态)。"""
    det = api("POST", "api/v1/course-study/course-front/register",
              data={"courseId": business_id})
    chapters = api("GET", "api/v1/course-study/subject/chapter-progress",
                   params={"courseId": business_id,
                           "versionId": det.get("versionId", ""),
                           "isRegister": det.get("register", False)})
    return det, chapters


def print_subject(det, chapters):
    print(f"\n===== {det.get('name')} =====")
    print(f"课时: {det.get('courseHour')} | 已报名: {det.get('register')} "
          f"| 学分: {det.get('credit')} | 学习人数: {det.get('registerMemberCount')}")
    done_n = all_n = 0
    for ch in chapters if isinstance(chapters, list) else []:
        print(f"\n◆ {ch.get('name', '章节')}")
        for sec in ch.get("courseChapterSections") or []:
            prog = sec.get("progress") or {}
            fin = prog.get("finishStatus", 0)
            mark = {2: "✅", 1: "🔷"}.get(fin, "  ")
            done_n += fin == 2
            all_n += 1
            # 小节可能内嵌课程信息
            ci = sec.get("courseInfo") or {}
            name = sec.get("name") or ci.get("name")
            ctype = ci.get("type", sec.get("type", ""))
            dur = ci.get("courseTime") or sec.get("courseTime") or ""
            print(f"  {mark} [{ctype}] {str(name)[:46]:48s} finishStatus={fin} {dur}")
    print(f"\n小计: {done_n}/{all_n} 小节已完成")


def main():
    items = list_tasks()
    print(f"任务总数(去重): {len(items)}")
    cls = classify(items)
    for k in ("未开始", "未完成"):
        arr = cls[k]
        print(f"\n== {k} ({len(arr)}) ==")
        for t in sorted(arr, key=lambda x: x.get("endTime") or 0):
            end = _ts(t.get("endTime"))
            print(f"  [{TYPE_NAME.get(t['businessType'], t['businessType'])}] "
                  f"{t['name'][:42]:46s} 截止:{end}")
    # 进入第一个在期未完成专题
    subjects = [t for t in cls["未完成"] if t["businessType"] == 2 and not t.get("expired")]
    if not subjects:
        subjects = [t for t in cls["未完成"] if t["businessType"] == 2]
    if subjects:
        s = subjects[0]
        det, chs = enter_subject(s["businessId"])
        print_subject(det, chs)


if __name__ == "__main__":  # pragma: no cover
    main()
