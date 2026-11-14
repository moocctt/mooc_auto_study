#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""线下集中培训（我的班级）采集。

数据源（实测 2026-11-04）：
  GET /api/v1/training/student/class-student/front/center-page?page=&pageSize=
      个人中心 →「班级」标签页的列表。一条 = 本人参加的一期培训班。
  GET /api/v1/training/student/class-info/front/basic/<classId>
      班级详情：classHour（线下学时）、classCourseHour（线上课程学时）、
      trainPlace、起止时间、trainType。

学时口径（已用平台数据反证，勿凭直觉改）：
  · 平台 totalClassHour（集中培训）== Σ classHour，且只算【当年 + 已结业】的班级。
    实测 2026：13 期班级，12 期已结业，Σ classHour = 64.00，与接口返回 64.0 完全一致。
  · 在读（graduateStatus=1）的班级不计入已完成学时，只算"待完成"。
  · 纯线上班级 classHour=0、classCourseHour>0（如"网上自学"的网络专题班），
    它们不算集中培训学时。

graduateStatus 实测取值：1=在读、3=已完成、4=已结业。
"""
from __future__ import annotations

import json
import time
from datetime import datetime, timedelta

import mooc_tasks as T

CACHE_FILE = T.DATA_DIR / "trainings.json"
CACHE_TTL_MIN = 60          # 缓存有效期（分钟）；详情接口要逐班请求，没必要每次重拉

GRADUATE_LABEL = {1: "在读", 2: "待结业", 3: "已完成", 4: "已结业"}
CLASS_STATUS_LABEL = {1: "未开始", 2: "报名中", 3: "报名结束", 5: "进行中", 6: "已结束", 7: "已结束"}


def _d(ms) -> str | None:
    return T._ms_to_date(ms)


def fetch_class_list(s) -> list[dict]:
    """拉全部「我的班级」，自动翻页。"""
    items, page = [], 1
    while True:
        j = T._get(s, "/training/student/class-student/front/center-page",
                   {"page": page, "pageSize": 50})
        batch = j.get("items") or []
        items += batch
        total = j.get("total")
        if not batch or (total is not None and len(items) >= int(total)) or page >= 40:
            break
        page += 1
    return items


def _detail(s, cid: str) -> dict:
    try:
        return T._get(s, f"/training/student/class-info/front/basic/{cid}") or {}
    except Exception:
        return {}


def fetch_trainings(s, refresh: bool = False) -> list[dict]:
    """返回全部培训班记录（含学时、地点、状态）。带本地缓存。"""
    if not refresh and CACHE_FILE.exists():
        try:
            cached = json.loads(CACHE_FILE.read_text(encoding="utf-8"))
            age = datetime.now() - datetime.fromisoformat(cached["fetched_at"])
            if age < timedelta(minutes=CACHE_TTL_MIN):
                return cached["trainings"]
        except Exception:
            pass

    rows = []
    for x in fetch_class_list(s):
        cid = x.get("classId") or ""
        info = x.get("classInfo") or {}
        b = _detail(s, cid)
        g = x.get("graduateStatus")
        rows.append({
            "class_id": cid,
            "title": (b.get("className") or info.get("className") or "").strip(),
            "start": _d(b.get("startTime") or info.get("startTime")),
            "end": _d(b.get("endTime") or info.get("endTime")),
            "class_hour": float(b.get("classHour") or 0),
            "course_hour": float(b.get("classCourseHour") or 0),
            "place": b.get("trainPlace") or "",
            "graduate_status": g,
            "graduate_label": GRADUATE_LABEL.get(g, str(g)),
            "status_label": CLASS_STATUS_LABEL.get(
                b.get("status") or info.get("status"), ""),
            "train_type": b.get("trainType"),
            "content": (b.get("trainContentShort") or b.get("trainContent") or "").strip(),
            "org": ((b.get("implementOrganization") or {}) if isinstance(
                b.get("implementOrganization"), dict) else {}).get("fullName") or "",
            "joined_at": _d(x.get("createTime")),
            "url": f"https://mooc.ctt.cn/#/train-new/class-detail/{cid}",
        })
        time.sleep(0.06)

    rows.sort(key=lambda r: (r["start"] or "", r["title"]))
    try:
        CACHE_FILE.write_text(json.dumps(
            {"fetched_at": datetime.now().isoformat(timespec="seconds"),
             "trainings": rows}, ensure_ascii=False, indent=1), encoding="utf-8")
        T._restrict_permissions(CACHE_FILE)
    except Exception:
        pass
    return rows


def summarize(rows: list[dict], year: int) -> dict:
    """按年汇总：已结业学时 / 在读学时 / 期数 / 地点分布。"""
    ys = str(year)
    in_year = [r for r in rows if (r["start"] or "").startswith(ys)]
    done = [r for r in in_year if r["graduate_status"] == 4]
    ongoing = [r for r in in_year if r["graduate_status"] != 4]
    by_year = {}
    for r in rows:
        y = (r["start"] or "")[:4] or "未知"
        a = by_year.setdefault(y, {"year": y, "count": 0, "done": 0, "hours": 0.0})
        a["count"] += 1
        a["hours"] += r["class_hour"]
        if r["graduate_status"] == 4:
            a["done"] += 1
    return {
        "year": year,
        "total_count": len(rows),
        "year_count": len(in_year),
        "year_done_count": len(done),
        "achieved_hours": round(sum(r["class_hour"] for r in done), 2),
        "ongoing_hours": round(sum(r["class_hour"] for r in ongoing), 2),
        "ongoing": ongoing,
        "year_items": in_year,
        "by_year": [by_year[k] for k in sorted(by_year)],
    }


def main(argv=None) -> int:
    import argparse
    p = argparse.ArgumentParser(description="我的班级（线下集中培训）采集")
    p.add_argument("--json", action="store_true")
    p.add_argument("--refresh", action="store_true", help="忽略缓存，重新逐班拉详情")
    p.add_argument("--year", type=int, default=datetime.now().year)
    a = p.parse_args(argv)
    token, _ = T.load_session()
    s = T.api_session(token)
    rows = fetch_trainings(s, refresh=a.refresh)
    sm = summarize(rows, a.year)
    if a.json:
        print(json.dumps({"summary": {k: v for k, v in sm.items() if k not in ("year_items", "ongoing")},
                          "trainings": rows}, ensure_ascii=False, indent=2))
        return 0
    print(f"我的班级：共 {sm['total_count']} 期；{a.year} 年 {sm['year_count']} 期，"
          f"已结业 {sm['year_done_count']} 期 → {sm['achieved_hours']:.2f} 学时")
    print(f"在读 {len(sm['ongoing'])} 期，待完成 {sm['ongoing_hours']:.2f} 学时")
    for r in sm["year_items"]:
        print(f"  {r['start']} ~ {r['end']}  {r['class_hour']:>5.1f} 学时  "
              f"{r['graduate_label']:<4} {r['place'][:16]:<18} {r['title'][:30]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
