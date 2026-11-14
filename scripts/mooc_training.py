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

import hashlib
import json
import sys
import time
from datetime import datetime, timedelta

import mooc_tasks as T

CACHE_FILE = T.DATA_DIR / "trainings.json"
CACHE_VERSION = 2           # 2 起缓存带 account 指纹与 detail_ok；旧结构一律视为未命中
CACHE_TTL_MIN = 60          # 缓存有效期（分钟）；详情接口要逐班请求，没必要每次重拉
PAGE_LIMIT = 40             # 翻页上限；到顶还没取完说明接口分页异常，宁可报错也不静默截断

GRADUATE_LABEL = {1: "在读", 2: "待结业", 3: "已完成", 4: "已结业"}
CLASS_STATUS_LABEL = {1: "未开始", 2: "报名中", 3: "报名结束", 5: "进行中", 6: "已结束", 7: "已结束"}
DONE_STATUS = (3, 4)        # 平台口径：3=已完成、4=已结业，都算已获学时


def _d(ms) -> str | None:
    return T._ms_to_date(ms)


def _year_key(r: dict) -> str:
    """年度归属：优先开班日期，缺失时依次回退结束日期 / 报名时间。"""
    return (r.get("start") or r.get("end") or r.get("joined_at") or "")[:4] or "未知"


def _account_key(s) -> str:
    """会话指纹：Authorization 头的 sha1 全量（截断会撞），换 token/换账号都能隔离缓存。

    注意这是**按会话**而非按账号：同账号重新登录会换 token，缓存因此 miss（宁可多查一次，
    也不要拿别人的班级数据当自己的）。
    """
    raw = str(s.headers.get("Authorization") or "")
    return hashlib.sha1(raw.encode("utf-8")).hexdigest() if raw else ""


class TrainingList(list):
    """培训班列表；failed 记录详情获取失败的期数（这些行的学时不可信）。"""

    failed = 0


def fetch_class_list(s) -> list[dict]:
    """拉全部「我的班级」，自动翻页；按 classId 去重（接口翻页偶有重复行）。"""
    items: dict[str, dict] = {}
    page = 1
    while True:
        j = T._get(s, "/training/student/class-student/front/center-page",
                   {"page": page, "pageSize": 50})
        batch = j.get("items") or []
        for x in batch:
            key = str(x.get("classId") or "") or f"__no_id_{len(items)}"
            items[key] = x
        total = j.get("total")
        if not batch or (total is not None and len(items) >= int(total)):
            break
        if page >= PAGE_LIMIT:
            raise RuntimeError(
                f"班级列表翻页超过 {PAGE_LIMIT} 页仍未取完（已取 {len(items)} 条，"
                f"接口 total={total}），请检查分页参数后再重试。")
        page += 1
    return list(items.values())


def _detail(s, cid: str) -> tuple[dict, bool]:
    """班级详情。失败返回 (空字典, False)，由调用方把该行标记为不可信。"""
    try:
        return (T._get(s, f"/training/student/class-info/front/basic/{cid}") or {}), True
    except T.AuthExpired:                      # token 失效不是「详情缺失」，不能当数据不全报给用户
        raise
    except Exception as e:
        print(f"  ! 班级 {cid} 详情获取失败：{e}", file=sys.stderr)
        return {}, False


def fetch_trainings(s, refresh: bool = False) -> list[dict]:
    """返回全部培训班记录（含学时、地点、状态）。带本地缓存（按账号隔离）。"""
    acct = _account_key(s)
    if not refresh and CACHE_FILE.exists():
        try:
            cached = json.loads(CACHE_FILE.read_text(encoding="utf-8"))
            # 旧结构没有 version / account：直接当未命中，免得沿用残缺或别人的数据
            if cached.get("version") != CACHE_VERSION or cached.get("account") != acct:
                raise ValueError("缓存结构或账号不匹配")
            age = datetime.now() - datetime.fromisoformat(cached["fetched_at"])
            if age < timedelta(minutes=CACHE_TTL_MIN):
                rows = cached.get("trainings") or []
                if all(r.get("detail_ok", False) for r in rows):
                    got = TrainingList(rows)
                    got.failed = 0
                    return got
        except Exception:
            pass

    rows = []
    failed = 0
    for x in fetch_class_list(s):
        cid = x.get("classId") or ""
        info = x.get("classInfo") or {}
        b, ok = _detail(s, cid)
        if not ok:
            failed += 1
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
            "detail_ok": ok,
            "url": f"https://mooc.ctt.cn/#/train-new/class-detail/{cid}",
        })
        time.sleep(0.06)

    rows.sort(key=lambda r: (r["start"] or "", r["title"]))
    # 有失败行就不写缓存：残缺的 class_hour 会被下次运行当命中，直接污染年度报告
    if failed:
        print(f"  ! {failed} 期班级详情获取失败，本次不写缓存。", file=sys.stderr)
    else:
        try:
            CACHE_FILE.write_text(json.dumps(
                {"version": CACHE_VERSION, "account": acct,
                 "fetched_at": datetime.now().isoformat(timespec="seconds"),
                 "trainings": rows}, ensure_ascii=False, indent=1), encoding="utf-8")
            T._restrict_permissions(CACHE_FILE)
        except Exception:
            pass
    got = TrainingList(rows)
    got.failed = failed
    return got


def summarize(rows: list[dict], year: int) -> dict:
    """按年汇总：已结业学时 / 在读学时 / 期数 / 地点分布。"""
    ys = str(year)
    in_year = [r for r in rows if _year_key(r) == ys]
    done = [r for r in in_year if r.get("graduate_status") in DONE_STATUS]
    ongoing = [r for r in in_year if r.get("graduate_status") not in DONE_STATUS]
    by_year = {}
    for r in rows:
        y = _year_key(r)
        a = by_year.setdefault(y, {"year": y, "count": 0, "done": 0, "hours": 0.0})
        a["count"] += 1
        if r.get("graduate_status") in DONE_STATUS:
            a["done"] += 1
            # 与 achieved_hours 同一谓词（当年 + 已完成/已结业），两处学时才能对上
            a["hours"] += float(r.get("class_hour") or 0)
    return {
        "year": year,
        "total_count": len(rows),
        "year_count": len(in_year),
        "year_done_count": len(done),
        "achieved_hours": round(sum(float(r.get("class_hour") or 0) for r in done), 2),
        "ongoing_hours": round(sum(float(r.get("class_hour") or 0) for r in ongoing), 2),
        "ongoing": ongoing,
        "year_items": in_year,
        # 缺开班日期的班级按结束日期 / 报名时间归属，报告里要标注
        "year_basis_fallback": len([r for r in in_year if not r.get("start")]),
        "detail_failed": len([r for r in rows if not r.get("detail_ok", True)]),
        "by_year": [by_year[k] for k in sorted(by_year)],
    }


def main(argv=None) -> int:
    import argparse
    p = argparse.ArgumentParser(description="我的班级（线下集中培训）采集")
    p.add_argument("--json", action="store_true")
    p.add_argument("--refresh", action="store_true", help="忽略缓存，重新逐班拉详情")
    p.add_argument("--year", type=int, default=T.cn_today().year)   # 平台口径的年度归属
    a = p.parse_args(argv)
    token, _ = T.load_session()
    s = T.api_session(token)
    rows = fetch_trainings(s, refresh=a.refresh)
    sm = summarize(rows, a.year)
    if a.json:
        print(json.dumps({"summary": {k: v for k, v in sm.items() if k not in ("year_items", "ongoing")},
                          "trainings": rows}, ensure_ascii=False, indent=2))
        return 0
    if sm["detail_failed"]:
        print(f"警告：{sm['detail_failed']} 期班级详情获取失败，学时与结论可能不完整。", file=sys.stderr)
    print(f"我的班级：共 {sm['total_count']} 期；{a.year} 年 {sm['year_count']} 期，"
          f"已结业 {sm['year_done_count']} 期 → {sm['achieved_hours']:.2f} 学时")
    print(f"在读 {len(sm['ongoing'])} 期，待完成 {sm['ongoing_hours']:.2f} 学时")
    for r in sm["year_items"]:
        print(f"  {r['start']} ~ {r['end']}  {r['class_hour']:>5.1f} 学时  "
              f"{r['graduate_label']:<4} {r['place'][:16]:<18} {r['title'][:30]}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except T.AuthExpired as exc:
        print(f"[会话] ⛔ {exc}", file=sys.stderr)
        print("[会话] 重新登录：python scripts/mooc_api.py qr wechat（扫码）"
              "或 python scripts/mooc_tasks.py login-pwd（账密）", file=sys.stderr)
        raise SystemExit(2)
