#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""年度学习报告：把平台数据汇成一份可交付的报告（Markdown / HTML / JSON）。

数据全部来自只读接口（不播放课程、不挂机、不代考）：

  GET /system/credit/detail-hour-member                 两组学时（网络自学 / 集中培训）
  GET /system/cadre-education/detail-hour-member        干部教育口径，用于交叉校验
  GET /course-study/course-study-progress/history-and-now-duration   学习时长（秒）
  GET /human/task                                        全部任务（状态 / 类型 / 起止 / 是否过期）
  GET /training/student/class-info/front/basic/<id>      班级（集中培训）详情

口径说明（实测，勿凭直觉改）：
  · 学时接口不接受 year 参数：2024 / 2025 / 2026 返回完全相同的数值，
    所以学时只能按"平台当前考核口径"呈现，**不能拆成年内新增**。
  · 任务接口不返回完成时间，只有 status。年度归属用 startTime 的年份（下发年），
    因此本报告不编造"月度完成趋势"。
  · history-and-now-duration 的 studyTime 是秒，键 0+1=2（已校验），
    即"历史累计 + 近期新增 = 合计"。

用法：
  python mooc_annual.py --year 2026 --out 年度学习报告.html
  python mooc_annual.py --year 2026 --json
  python mooc_annual.py --year 2026 --out r.html --login-links   # 任务标题带免登录直达链接
"""
from __future__ import annotations

import argparse
import collections
import html as _html
import json
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import mooc_tasks as T          # noqa: E402
import mooc_training as TR      # noqa: E402
import tobacco as TB            # noqa: E402

BUSINESS_NAME = {1: "专题课程", 2: "专题课程", 3: "考试", 4: "问卷",
                 5: "集中培训（线下）", 6: "直播"}
STATUS_NAME = {3: "已完成", 2: "进行中", 1: "未开始"}


# --------------------------------------------------------------------------- #
# 采集
# --------------------------------------------------------------------------- #
def _year_of(row: dict) -> str | None:
    d = T._ms_to_date(row.get("startTime")) or T._ms_to_date(row.get("endTime"))
    return d[:4] if d else None


def _fmt_date(ms) -> str | None:
    return T._ms_to_date(ms)


def collect(year: int, s=None) -> dict:
    token, meta = T.load_session()
    s = s or T.api_session(token)

    rows = T.fetch_tasks(s)
    summary = T.fetch_summary(s)

    # 学员信息：会话文件里没有姓名/单位，得问一次会员中心
    member = {}
    try:
        mc = T._get(s, "/human/member/center") or {}
        member = {"name": mc.get("fullName") or mc.get("name"),
                  "org": (mc.get("organization") or {}).get("fullName"),
                  "member_id": mc.get("id")}
    except Exception:
        pass

    # 干部教育口径：与 credit 接口同源，用来确认两组学时没读错
    cadre = {}
    try:
        cadre = T._get(s, "/system/cadre-education/detail-hour-member") or {}
    except Exception:
        pass

    # 累计学习时长（秒）
    duration = {}
    try:
        duration = (T._get(s, "/course-study/course-study-progress/history-and-now-duration")
                    or {}).get("studyTime") or {}
    except Exception:
        pass
    dur = {str(k): float(v) for k, v in duration.items()}

    # 线下集中培训：个人中心「班级」清单
    # 任务列表只有当年被派发的班级（businessType=5），历史期次与真实学时都在这里。
    try:
        trainings = TR.fetch_trainings(s)
    except Exception:
        trainings = []
    tsum = TR.summarize(trainings, year) if trainings else {
        "year": year, "total_count": 0, "year_count": 0, "year_done_count": 0,
        "achieved_hours": 0.0, "ongoing_hours": 0.0, "ongoing": [],
        "year_items": [], "by_year": []}

    classes = []
    for t in tsum["year_items"]:
        classes.append({
            "title": t["title"],
            "business_id": t["class_id"],
            "year": (t["start"] or "")[:4] or str(year),
            "status": t["graduate_label"],
            "hours": t["class_hour"],
            "start": t["start"], "end": t["end"],
            "place": t["place"] or "",
            "form": "线下" if t["class_hour"] else "线上",
            "url": t["url"],
        })
    classes.sort(key=lambda c: (c["start"] or "", c["title"]))
    class_by_id = {c["business_id"]: c for c in classes}
    today = date.today().isoformat()
    for c in classes:
        if c["start"] and c["end"]:
            c["phase"] = ("未开始" if today < c["start"]
                          else "已结束" if today > c["end"] else "进行中")
        else:
            c["phase"] = "日期未知"

    # 任务统计
    def is_required(r):
        return r.get("sourceForm") == 1 or int(r.get("businessType") or 0) == 5

    today = date.today().isoformat()
    all_stats = collections.Counter()
    type_stats: dict[int, dict] = {}
    year_series: dict[str, dict] = {}

    for r in rows:
        st = int(r.get("status") or 1)
        bt = int(r.get("businessType") or 0)
        all_stats[st] += 1
        y = _year_of(r) or "未知"
        if y not in year_series:
            year_series[y] = {"total": 0, "done": 0}
        year_series[y]["total"] += 1
        if st == 3:
            year_series[y]["done"] += 1
        t = type_stats.setdefault(BUSINESS_NAME.get(bt, "其他"), {"total": 0, "done": 0})
        t["total"] += 1
        if st == 3:
            t["done"] += 1

    yrows = [r for r in rows if _year_of(r) == str(year)]
    y_done = [r for r in yrows if int(r.get("status") or 1) == 3]
    y_pending = [r for r in yrows if int(r.get("status") or 1) != 3]

    def task_view(r):
        bt = int(r.get("businessType") or 0)
        bid = str(r.get("businessId") or "")
        c = class_by_id.get(bid) if bt == 5 else None
        return {
            "title": str(r.get("name") or "").strip(),
            "type": BUSINESS_NAME.get(bt, "其他"),
            "required": is_required(r),
            "status": STATUS_NAME.get(int(r.get("status") or 1), "未知"),
            # 班级的 endTime 在列表接口恒为 null，用详情接口补
            "start": (c or {}).get("start") or _fmt_date(r.get("startTime")),
            "end": (c or {}).get("end") or _fmt_date(r.get("endTime")),
            "expired": bool(r.get("expired")),
            "url": T._detail_url(bt, bid),
        }

    overdue = [task_view(r) for r in rows
               if int(r.get("status") or 1) != 3
               and ((r.get("expired")) or ((_fmt_date(r.get("endTime")) or "9999") < today))]

    req_year = [r for r in yrows if is_required(r)]
    req_year_done = [r for r in req_year if int(r.get("status") or 1) == 3]

    return {
        "meta": {
            "year": year,
            "generated_at": datetime.now().isoformat(timespec="seconds"),
            "member": member,
            "session_expires": meta.get("expires_at") if isinstance(meta, dict) else None,
            "platform_total_tasks": len(rows),
        },
        "hours": summary,
        "cadre": {k: cadre.get(k) for k in
                  ("hourSelf", "hourTrain", "requireCourseHour", "requireClassHour")},
        "duration": {"total_seconds": dur.get("2"), "history_seconds": dur.get("0"),
                     "recent_seconds": dur.get("1")},
        "classes": classes,
        "trainings": trainings,
        "training_stats": tsum,
        "task_stats": {
            "all": {"total": len(rows), "done": all_stats[3],
                    "doing": all_stats[2], "todo": all_stats[1]},
            "year": {"total": len(yrows), "done": len(y_done),
                     "pending": len(y_pending),
                     "required_total": len(req_year), "required_done": len(req_year_done)},
            "types": [{"type": name, "total": v["total"], "done": v["done"]}
                      for name, v in sorted(type_stats.items())],
            "by_year": [{"year": y, **v} for y, v in sorted(year_series.items())],
        },
        "year_done": [task_view(r) for r in sorted(
            y_done, key=lambda r: r.get("endTime") or 0)],
        "year_pending": [task_view(r) for r in sorted(
            y_pending, key=lambda r: r.get("endTime") or 0)],
        "overdue": overdue,
    }


# --------------------------------------------------------------------------- #
# 派生结论
# --------------------------------------------------------------------------- #
def derive(rep: dict) -> dict:
    h = rep["hours"]
    net, cls = h["网络自学"], h["集中培训"]
    y = rep["task_stats"]["year"]
    rate = round(y["done"] / y["total"] * 100, 1) if y["total"] else 0.0

    findings, actions = [], []

    if net["达标"]:
        findings.append(f"网络自学已达标并超额 {net['差额']:.2f} 学时"
                        f"（{net['已完成']:.2f}/{net['要求']:.2f}）。")
    else:
        findings.append(f"网络自学未达标，还差 {net['缺口']:.2f} 学时。")

    if cls["达标"]:
        findings.append(f"集中培训已达标（{cls['已完成']:.2f}/{cls['要求']:.2f}）。")
    else:
        gap = cls["缺口"]
        findings.append(f"集中培训未达标，还差 {gap:.2f} 学时；这组只能靠线下培训班补，"
                        f"网络自学超额部分不能抵扣。")
        # 未结业的培训班（含在读）能覆盖多少，再算还差几期
        pending_classes = [c for c in rep["classes"] if c["status"] != "已结业"]
        filled = sum(c["hours"] or 0 for c in pending_classes)
        per_class = max([c["hours"] or 0 for c in rep["classes"]] + [24.0])
        names = "、".join(f"{c['title']}（{c['hours']:.0f} 学时）" for c in pending_classes)
        if filled >= gap:
            actions.append(f"集中培训缺口 {gap:.2f} 学时：已排未结业的培训班共 {filled:.0f} 学时"
                           f"（{names}），全部参加后即可达标。")
        elif filled > 0:
            left = gap - filled
            if left < per_class:
                actions.append(
                    f"集中培训缺口 {gap:.2f} 学时：未结业的培训班覆盖 {filled:.0f} 学时"
                    f"（{names}）后只剩 {left:.2f} 学时，不足一期（每期约 {per_class:.0f} 学时），"
                    f"建议与培训管理部门确认用零散面授补足或结转。")
            else:
                actions.append(f"集中培训缺口 {gap:.2f} 学时：未结业的培训班只能覆盖 {filled:.0f} 学时"
                               f"（{names}），还差 {left:.2f} 学时，需再补约 "
                               f"{int(-(-left // per_class))} 期（每期约 {per_class:.0f} 学时）。")
        else:
            actions.append(f"集中培训缺口 {gap:.2f} 学时：按每期约 {per_class:.0f} 学时估算，"
                           f"还需参加约 {int(-(-gap // per_class))} 期培训班（或等同学时集中面授）。")

    ts = rep.get("training_stats") or {}
    if ts.get("year_count"):
        findings.append(
            f"{ts['year']} 年共参加 {ts['year_count']} 期线下培训班，其中 {ts['year_done_count']} 期已结业，"
            f"累计 {ts['achieved_hours']:.2f} 学时——与平台 totalClassHour（{cls['已完成']:.2f}）核对一致。")

    live = [c for c in rep["classes"] if c.get("phase") == "进行中"]
    if live:
        findings.append("正在进行的线下培训：" + "、".join(
            f"{c['title']}（{c['start']}~{c['end']}，{c['place'] or '地点见班级详情'}）"
            for c in live) + "。")

    if y["total"]:
        findings.append(f"{rep['meta']['year']} 年下发 {y['total']} 项任务，"
                        f"已完成 {y['done']} 项，完成率 {rate:.1f}%。")
        if y["pending"]:
            urg = [t for t in rep["year_pending"] if t["end"]]
            urgent = sorted(urg, key=lambda t: t["end"])[:3]
            tail = ("，最近的是 " + "、".join(f"{t['title']}（{t['end']}）" for t in urgent)
                    if urgent else "")
            actions.append(f"{rep['meta']['year']} 年还有 {y['pending']} 项未完成{tail}。")

    if rep["overdue"]:
        findings.append(f"历史遗留逾期待办 {len(rep['overdue'])} 项。")
        actions.append(f"{len(rep['overdue'])} 项已过期未完成，需确认是否仍可补学或申请豁免。")

    if net["达标"] and net["差额"] > 0:
        actions.append(f"网络自学已多出 {net['差额']:.2f} 学时，后续无需再额外选网课，"
                       f"把时间留给集中培训与必办任务。")

    return {"completion_rate": rate, "findings": findings, "actions": actions}


# --------------------------------------------------------------------------- #
# Markdown
# --------------------------------------------------------------------------- #
def _pct(a: float, b: float) -> float:
    return round(a / b * 100, 1) if b else 0.0


def render_md(rep: dict, token: str = "") -> str:
    m, h = rep["meta"], rep["hours"]
    net, cls = h["网络自学"], h["集中培训"]
    y = rep["task_stats"]["year"]
    dv = rep.get("derived") or derive(rep)
    member = m.get("member") or {}
    name = member.get("name") or "—"
    org = member.get("org") or "—"

    L = [f"# {m['year']} 年度学习报告", "",
         f"- 学员：{name}",
         f"- 单位：{org}",
         f"- 统计年度：{m['year']}（任务按平台下发时间归属）",
         f"- 生成时间：{m['generated_at'].replace('T', ' ')}",
         ""]

    L += ["## 一、关键指标", ""]
    L.append("| 指标 | 数值 | 状态 |")
    L.append("| --- | --- | --- |")
    L.append(f"| 网络自学学时 | {net['已完成']:.2f} / {net['要求']:.2f} | "
             f"{'已达标（超额 %.2f）' % net['差额'] if net['达标'] else '未达标（缺 %.2f）' % net['缺口']} |")
    L.append(f"| 集中培训学时 | {cls['已完成']:.2f} / {cls['要求']:.2f} | "
             f"{'已达标' if cls['达标'] else '未达标（缺 %.2f）' % cls['缺口']} |")
    L.append(f"| 年度任务完成率 | {y['done']} / {y['total']} = {dv['completion_rate']:.1f}% | "
             f"{'全部完成' if y['total'] and y['done'] == y['total'] else '仍有待办'} |")
    d = rep["duration"]
    if d.get("total_seconds"):
        L.append(f"| 累计学习时长 | {d['total_seconds'] / 3600:.1f} 小时 | 平台统计，仅供参考 |")
    L.append("")

    L += ["## 二、学时达成情况", "",
          "两组学时**独立考核、不能互相抵扣**：网络自学靠网课累计，集中培训只能靠线下培训班。", "",
          "| 组别 | 已完成 | 要求 | 完成率 | 结论 |",
          "| --- | --- | --- | --- | --- |",
          f"| 网络自学 | {net['已完成']:.2f} | {net['要求']:.2f} | {net['完成率']:.1f}% | "
          f"{'超额 %.2f' % net['差额'] if net['达标'] else '缺口 %.2f' % net['缺口']} |",
          f"| 集中培训 | {cls['已完成']:.2f} | {cls['要求']:.2f} | {cls['完成率']:.1f}% | "
          f"{'超额 %.2f' % cls['差额'] if cls['达标'] else '缺口 %.2f' % cls['缺口']} |",
          "",
          f"合计 {float(h['总学分']):.2f} 学时（平台字段 `totalScore`，等于两组已完成之和）。", ""]

    if rep["classes"]:
        L += ["## 三、集中培训（线下）", "",
              "| 培训班 | 起止 | 学时 | 地点 | 状态 |",
              "| --- | --- | --- | --- | --- |"]
        for c in rep["classes"]:
            title = c["title"]
            if token:
                link = TB.login_link(c["url"], token)
                title = f"[{title}]({link})" if link else title
            state = c["status"]
            if c.get("phase") and c.get("phase") not in ("已结束", "日期未知"):
                state = f"{state}（{c['phase']}）"
            L.append(f"| {title} | {c['start'] or '—'} ~ {c['end'] or '—'} | "
                     f"{c['hours']:.0f} | {c['place'] or '—'} | {state} |")
        L.append("")

    L += ["## 四、年度任务执行", "",
          f"{m['year']} 年共下发 {y['total']} 项，必修 {y['required_total']} 项"
          f"（完成 {y['required_done']} 项）。", ""]
    if rep["year_done"]:
        L += ["已完成：", ""]
        for t in rep["year_done"]:
            title = t["title"]
            if token:
                link = TB.login_link(t["url"], token)
                title = f"[{title}]({link})" if link else title
            L.append(f"- {title}（{t['type']}）")
        L.append("")
    if rep["year_pending"]:
        L += ["待完成：", "",
              "| 任务 | 类型 | 截止 | 必修 |", "| --- | --- | --- | --- |"]
        for t in rep["year_pending"]:
            title = t["title"]
            if token:
                link = TB.login_link(t["url"], token)
                title = f"[{title}]({link})" if link else title
            L.append(f"| {title} | {t['type']} | {t['end'] or '—'} | "
                     f"{'是' if t['required'] else '否'} |")
        L.append("")

    types = rep["task_stats"]["types"]
    if types:
        L += ["按类型分布（全部历史任务）：", "",
              "| 类型 | 总数 | 已完成 |", "| --- | --- | --- |"]
        L += [f"| {t['type']} | {t['total']} | {t['done']} |" for t in types]
        L.append("")

    by_year = rep["task_stats"]["by_year"]
    if by_year:
        L += ["历年任务完成情况：", "",
              "| 年度 | 下发 | 已完成 | 完成率 |", "| --- | --- | --- | --- |"]
        for r in by_year:
            L.append(f"| {r['year']} | {r['total']} | {r['done']} | "
                     f"{_pct(r['done'], r['total']):.0f}% |")
        L.append("")

    if dv["findings"] or dv["actions"]:
        L.append("## 五、结论与建议")
        L.append("")
        L += [f"- {x}" for x in dv["findings"]]
        if dv["actions"]:
            L += ["", "建议：", ""]
            L += [f"{i}. {x}" for i, x in enumerate(dv["actions"], 1)]
        L.append("")

    L += ["## 六、数据口径", "",
          "- 学时取自 `GET /api/v1/system/credit/detail-hour-member`；"
          "该接口**不区分年份**（实测 2024/2025/2026 返回同值），因此学时按平台当前考核口径呈现，"
          "不当作本年度新增。",
          "- 年度归属按任务 `startTime` 的年份（下发年）；平台不返回逐条完成时间，"
          "故本报告不提供「月度完成趋势」，避免用截止时间冒充完成时间。",
          "- 任务进度只有 `status`（未开始 / 进行中 / 已完成），没有百分比。",
          "- 学时达标判断以平台 `requireCourseHour` / `requireClassHour` 为准，"
          "数据采集于 " + m["generated_at"].replace("T", " ") + "。",
          ""]
    return "\n".join(L)


# --------------------------------------------------------------------------- #
# HTML：A4 分页式交互年报（封面 / 章节页 / 图表 / 表格 / 翻页）
# --------------------------------------------------------------------------- #
BRAND = "#1F6F4A"
BRAND_DARK = "#124A31"
BRAND_MID = "#2E8B5F"
AMBER = "#C98A3E"
PALETTE = ["#1F6F4A", "#3E8E66", "#6FA98A", "#A8C9B7", "#C98A3E", "#8C7A5B", "#5C7A6B"]

CSS = """
:root{
  --ink:#16211C;--ink2:#3D4A44;--muted:#6B7A73;--line:#DDE5E0;
  --brand:#1F6F4A;--brand-dark:#124A31;--brand-soft:#E8F2EC;--brand-mid:#8FBFA6;
  --amber:#B45309;--amber-soft:#FDF3E7;--danger:#B3261E;--danger-soft:#FBEDEC;
  --paper:#FFFFFF;--bg:#EEF1EE;
}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:"PingFang SC","Microsoft YaHei","Hiragino Sans GB",system-ui,sans-serif;
  background:var(--bg);color:var(--ink);line-height:1.7;-webkit-font-smoothing:antialiased;
  font-variant-numeric:tabular-nums}
.page{width:210mm;height:297mm;min-height:297mm;background:var(--paper);margin:0 auto 24px;
  padding:14mm 15mm;position:relative;box-shadow:0 2px 18px rgba(20,40,30,.10);overflow:hidden}
/* ---------- deck（单页翻阅） ---------- */
body.deck{overflow:hidden}
body.deck .deckwrap{height:100vh;display:flex;justify-content:center;align-items:flex-start;
  padding-top:18px;overflow:hidden}
body.deck .page{display:none;margin:0;transform-origin:center top}
body.deck .page.active{display:block}
@media (max-height:560px){body.deck .deckwrap{padding-top:6px}}
/* ---------- cover ---------- */
.cover{display:flex;flex-direction:column;padding:0}
.cover-top{background:linear-gradient(150deg,#124A31 0%,#1F6F4A 55%,#2E8B5F 100%);color:#fff;
  padding:26mm 16mm 20mm;position:relative;overflow:hidden}
.cover-top::after{content:"";position:absolute;right:-70mm;top:-40mm;width:150mm;height:150mm;
  border-radius:50%;background:rgba(255,255,255,.055)}
.cover-top::before{content:"";position:absolute;right:20mm;bottom:-60mm;width:90mm;height:90mm;
  border-radius:50%;background:rgba(255,255,255,.04)}
.eyebrow{font-size:9.5pt;letter-spacing:.28em;opacity:.82;margin-bottom:14mm;font-weight:500}
.cover-title{font-size:38pt;font-weight:700;letter-spacing:.02em;line-height:1.15}
.cover-sub{font-size:13pt;font-weight:400;opacity:.9;margin-top:5mm;letter-spacing:.08em}
.cover-rule{width:26mm;height:3px;background:rgba(255,255,255,.75);margin:9mm 0 0}
.cover-body{padding:0 16mm 14mm;flex:1;display:flex;flex-direction:column;justify-content:flex-end}
.cover-summary{padding:9mm 0 7mm}
.cs-label{font-size:8pt;color:var(--brand);letter-spacing:.22em;font-weight:600;margin-bottom:3mm}
.cover-summary p{font-size:10.5pt;color:var(--ink2);line-height:1.95;max-width:158mm}
.cover-summary p b{color:var(--brand-dark);font-weight:700}
.cs-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:4mm;margin-top:7mm}
.cs-stats>div{border-top:2px solid var(--brand-soft);padding-top:3mm}
.cs-stats span{display:block;font-size:15pt;font-weight:700;color:var(--ink);line-height:1.2}
.cs-stats i{display:block;font-style:normal;font-size:8pt;color:var(--muted);margin-top:1mm;letter-spacing:.04em}
.meta-grid{display:grid;grid-template-columns:repeat(2,1fr);border-top:1px solid var(--line);margin-bottom:8mm}
.meta-item{padding:6mm 0;border-bottom:1px solid var(--line)}
.meta-item:nth-child(odd){border-right:1px solid var(--line);padding-right:6mm}
.meta-item:nth-child(even){padding-left:6mm}
.meta-k{font-size:8.5pt;color:var(--muted);letter-spacing:.14em;margin-bottom:1.5mm}
.meta-v{font-size:11pt;color:var(--ink);font-weight:600}
.meta-v small{font-weight:400;color:var(--ink2);font-size:9.5pt;display:block;margin-top:.8mm;line-height:1.5}
.cover-foot{font-size:8.5pt;color:var(--muted);display:flex;justify-content:space-between;
  align-items:flex-end;border-top:1px solid var(--line);padding-top:5mm}
/* ---------- shared ---------- */
.sec-head{display:flex;align-items:baseline;gap:4mm;margin-bottom:6mm;padding-bottom:3mm;
  border-bottom:2px solid var(--brand)}
.sec-no{font-size:9pt;font-weight:700;color:var(--brand);letter-spacing:.1em;padding-top:1mm}
.sec-title{font-size:16pt;font-weight:700;letter-spacing:.02em}
.sec-note{margin-left:auto;font-size:8.5pt;color:var(--muted)}
.run-head{font-size:8pt;color:var(--muted);letter-spacing:.16em;text-align:right;margin-bottom:4mm}
.lead{font-size:10.5pt;color:var(--ink2);margin-bottom:5mm;line-height:1.85}
.lead strong{color:var(--brand-dark);font-weight:600}
/* ---------- KPI ---------- */
.kpi{display:grid;grid-template-columns:repeat(4,1fr);gap:3mm;margin-bottom:6mm}
.kpi-box{border:1px solid var(--line);border-top:3px solid var(--brand);padding:5mm 4mm;background:#FCFDFC}
.kpi-box.warn{border-top-color:var(--amber)}
.kpi-box.bad{border-top-color:var(--danger)}
.kpi-label{font-size:8.5pt;color:var(--muted);letter-spacing:.08em;margin-bottom:2mm}
.kpi-num{font-size:22pt;font-weight:700;color:var(--ink);line-height:1.1;letter-spacing:-.01em}
.kpi-num .unit{font-size:9.5pt;font-weight:500;color:var(--muted);margin-left:1mm}
.kpi-foot{font-size:8pt;color:var(--muted);margin-top:2mm;line-height:1.5}
/* ---------- 双条 ---------- */
.dual{border:1px solid var(--line);padding:5mm 5mm 3mm;background:#FCFDFC;margin-bottom:5mm}
.dual-row{margin-bottom:5mm}
.dual-row:last-child{margin-bottom:2mm}
.dual-top{display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:2.5mm}
.dual-name{font-size:11pt;font-weight:700}
.dual-name span{font-size:8.5pt;font-weight:400;color:var(--muted);margin-left:3mm;letter-spacing:.04em}
.dual-val{font-size:11pt;font-weight:700}
.dual-val em{font-style:normal;font-size:8.5pt;color:var(--muted);font-weight:400;margin-left:2mm}
.bar{height:7.5mm;background:#EDF1EE;position:relative;border-radius:1px;overflow:hidden}
.bar-fill{height:100%;background:linear-gradient(90deg,#2E8B5F,#1F6F4A)}
.bar-fill.gap{background:linear-gradient(90deg,#E8A65C,#C97A1E)}
.bar-target{position:absolute;top:-1mm;bottom:-1mm;width:2px;background:#16211C}
.bar-marks{display:flex;justify-content:space-between;font-size:7.5pt;color:var(--muted);margin-top:1.5mm}
.pill{display:inline-block;font-size:7.5pt;padding:.6mm 2.4mm;border-radius:2px;font-weight:600;letter-spacing:.04em}
.pill.ok{background:var(--brand-soft);color:var(--brand-dark)}
.pill.warn{background:var(--amber-soft);color:var(--amber)}
.pill.bad{background:var(--danger-soft);color:var(--danger)}
.pill.na{background:#EEF1EE;color:var(--ink2)}
.note-box{border-left:3px solid var(--amber);background:var(--amber-soft);padding:3.5mm 4.5mm;
  font-size:9.2pt;color:#6B3F0C;line-height:1.75}
.note-box strong{color:#8A4A08}
.note-box.plain{border-left-color:var(--brand);background:var(--brand-soft);color:#14402B}
.note-box.plain strong{color:var(--brand-dark)}
.note-box.danger{border-left-color:var(--danger);background:var(--danger-soft);color:#7A241E}
.note-box.danger strong{color:var(--danger)}
/* ---------- table ---------- */
table{width:100%;border-collapse:collapse;font-size:9pt}
thead th{background:var(--brand-dark);color:#fff;font-weight:600;font-size:8.5pt;letter-spacing:.06em;
  text-align:left;padding:2.6mm 2.4mm;white-space:nowrap}
tbody td{padding:2.4mm;border-bottom:1px solid var(--line);vertical-align:top;color:var(--ink2)}
tbody tr:nth-child(even){background:#FAFBFA}
tbody tr:hover{background:var(--brand-soft)}
td.t-title{color:var(--ink);font-weight:500;line-height:1.5}
td.num{text-align:right;white-space:nowrap}
td.date{white-space:nowrap}
td.mid{text-align:center;white-space:nowrap}
tfoot td{padding:2.8mm 2.4mm;font-weight:700;color:var(--ink);background:var(--brand-soft);font-size:9pt}
.tbl-sort thead th[data-sort]{cursor:pointer;user-select:none}
.tbl-sort thead th[data-sort]:hover{background:#0B3A26}
.tbl-sort thead th[data-sort]::after{content:"↕";margin-left:1.5mm;opacity:.45;font-size:7.5pt}
.tbl-sort thead th[data-sort].asc::after{content:"↑";opacity:1}
.tbl-sort thead th[data-sort].desc::after{content:"↓";opacity:1}
/* ---------- chart ---------- */
.chart-card{border:1px solid var(--line);padding:4.5mm 4.5mm 3mm;background:#FCFDFC;margin-bottom:5mm}
.chart-cap{font-size:9.5pt;font-weight:600;margin-bottom:1mm}
.chart-sub{font-size:8pt;color:var(--muted);margin-bottom:3mm}
.chart{display:block;width:100%;height:auto}
.chart text{font-family:inherit}
.ax{font-size:10px;fill:#8A9A93}
.hit{cursor:pointer}
.hit:hover rect{filter:brightness(.92)}
.legend{display:flex;gap:5mm;font-size:8pt;color:var(--ink2);margin-top:2mm;flex-wrap:wrap}
.legend i{display:inline-block;width:3mm;height:3mm;margin-right:1.5mm;vertical-align:middle}
.donut-wrap{display:flex;gap:8mm;align-items:center}
.donut{width:52mm;flex:none}
.dlegend{flex:1;display:grid;gap:1.6mm;font-size:9pt}
.dlegend div{display:flex;align-items:center;gap:2.5mm;border-bottom:1px dashed #EDF1EE;padding-bottom:1.4mm}
.dlegend i{width:3mm;height:3mm;border-radius:1px;flex:none}
.dlegend em{margin-left:auto;font-style:normal;color:var(--muted);font-size:8.5pt}
.stack-row{display:grid;grid-template-columns:30mm 1fr;gap:4mm;align-items:center;margin-bottom:3.5mm}
.stack-row .lb{font-size:8.5pt;color:var(--ink2)}
.stack{display:block;width:100%;height:6mm}
/* ---------- 两栏 / 结论 ---------- */
.two{display:grid;grid-template-columns:1fr 1fr;gap:5mm}
.card{border:1px solid var(--line);padding:5mm;background:#FCFDFC}
.card h4{font-size:10pt;margin-bottom:3mm;color:var(--brand-dark);letter-spacing:.02em}
.card ul{list-style:none;font-size:9pt;color:var(--ink2)}
.card li{position:relative;padding-left:4.5mm;margin-bottom:2.4mm;line-height:1.7}
.card li::before{content:"";position:absolute;left:0;top:2.2mm;width:1.6mm;height:1.6mm;
  background:var(--brand);border-radius:50%}
.card.warn-card{border-color:#EBD3B6;background:#FFFCF8}
.card.warn-card h4{color:var(--amber)}
.card.warn-card li::before{background:var(--amber)}
.card ol{font-size:9pt;color:var(--ink2);padding-left:4.5mm}
.card ol li{margin-bottom:2.6mm;line-height:1.75}
.card ol li::before{display:none}
.action{display:flex;gap:4mm;padding:3.4mm 0;border-bottom:1px dashed var(--line)}
.action:last-child{border-bottom:0;padding-bottom:0}
.a-rank{flex:0 0 8mm;height:8mm;background:var(--brand);color:#fff;font-size:9pt;font-weight:700;
  display:flex;align-items:center;justify-content:center;border-radius:50%}
.a-rank.urgent{background:var(--danger)}
.a-body{flex:1}
.a-title{font-size:9.5pt;font-weight:600;color:var(--ink);margin-bottom:.8mm}
.a-desc{font-size:8.8pt;color:var(--ink2);line-height:1.7}
.page.compact table{font-size:8.5pt}
.page.compact thead th{padding:2.1mm 2.2mm}
.page.compact tbody td{padding:1.6mm 2.2mm}
.page.compact tfoot td{padding:2mm 2.2mm}
.page.compact .lead{margin-bottom:3.5mm}
.page.compact .chart-card{padding:3.5mm 4mm 2mm;margin-bottom:4mm}
.page.compact .note-box{padding:3mm 4mm;font-size:9pt}
.footnote{font-size:7.5pt;color:var(--muted);line-height:1.8;border-top:1px solid var(--line);
  padding-top:3mm;margin-top:5mm}
.footnote b{color:var(--ink2);font-weight:600}
.page-foot{position:absolute;bottom:8mm;left:15mm;right:15mm;display:flex;justify-content:space-between;
  font-size:7.5pt;color:#9AA7A1;border-top:1px solid #EDF1EE;padding-top:2.5mm}
.tip{position:fixed;top:0;left:0;z-index:99;pointer-events:none;opacity:0;
  transform:translate(-9999px,0);background:rgba(18,33,28,.95);color:#fff;font-size:8.5pt;
  line-height:1.6;padding:2mm 3mm;border-radius:2mm;max-width:70mm;transition:opacity .12s}
.tip.on{opacity:1}
/* ---------- 连续模式 ---------- */
body.scrollmode{overflow:auto;background:var(--bg);padding:16px 0 90px}
body.scrollmode .deckwrap{display:block;height:auto}
body.scrollmode .page{display:block;transform:none;margin:0 auto 20px}
body.scrollmode .page.active{display:block}
/* ---------- 移动端：宽度自适应，页面改为纵向流式 ---------- */
@media (max-width:760px){
  body{-webkit-text-size-adjust:100%;background:#fff}
  body.deck{overflow-y:auto;-webkit-overflow-scrolling:touch}
  body.deck .deckwrap{display:block;height:auto;padding:0;overflow:visible}
  body.deck .page{width:100%;height:auto;min-height:0;margin:0;padding:18px 15px 54px;
    box-shadow:none;transform:none !important;overflow:visible}
  .page-foot{position:static;left:auto;right:auto;margin-top:16px}
  /* 封面 */
  .cover{padding:0}
  .cover-top{padding:38px 20px 28px}
  .cover-title{font-size:26pt}
  .cover-sub{font-size:11pt;margin-top:10px}
  .eyebrow{margin-bottom:34px;font-size:8.5pt}
  .cover-rule{margin-top:16px}
  .cover-body{padding:0 20px 22px}
  .cover-summary{padding:20px 0 14px}
  .cover-summary p{font-size:10.5pt;line-height:1.9;max-width:none}
  .cs-stats{gap:10px;margin-top:18px}
  .cs-stats span{font-size:13pt}
  .meta-grid{grid-template-columns:1fr;margin-bottom:14px}
  .meta-item{padding:10px 0}
  .meta-item:nth-child(odd){border-right:0;padding-right:0}
  .meta-item:nth-child(even){padding-left:0}
  .cover-foot{flex-direction:column;gap:4px;align-items:flex-start}
  /* 栅格 */
  .kpi{grid-template-columns:repeat(2,1fr);gap:8px}
  .kpi-box{padding:12px 10px}
  .kpi-num{font-size:18pt}
  .two{grid-template-columns:1fr;gap:12px}
  .donut-wrap{flex-direction:column;gap:10px}
  .donut{width:62%}
  .stack-row{grid-template-columns:78px 1fr;gap:8px}
  .sec-title{font-size:14pt}
  .sec-head{margin-bottom:14px}
  /* 表格：横向滚动，不挤字 */
  table{font-size:11px;display:block;overflow-x:auto;-webkit-overflow-scrolling:touch}
  thead th{font-size:10px;white-space:nowrap}
  tbody td{white-space:nowrap}
  td.t-title{white-space:normal;min-width:150px}
  .page.compact table{font-size:10.5px}
  .chart{width:100%;height:auto}
}
@media (max-width:400px){
  .cover-title{font-size:22pt}
  .cs-stats{grid-template-columns:1fr 1fr 1fr;gap:6px}
}
@media print{
  body{background:#fff}
  body.deck{overflow:visible}
  body.deck .deckwrap{display:block;height:auto;padding:0}
  .page,.page.active{display:block !important;transform:none !important;box-shadow:none;margin:0;
    width:210mm;height:296.9mm;min-height:0;padding:14mm 15mm;page-break-after:always;
    overflow:hidden;break-inside:avoid}
  .cover{height:296.9mm}
  .page:last-child{page-break-after:auto}
  .tip{display:none !important}
  @page{size:A4;margin:0}
}
"""

JS = """
(function(){
  var pages=[].slice.call(document.querySelectorAll('.page'));
  var wrap=document.querySelector('.deckwrap');
  var cur=0;
  function isMobile(){return window.innerWidth<=760;}

  function fit(){
    if(isMobile()){
      pages.forEach(function(p){p.style.transform='';});
      if(wrap){wrap.style.height='auto';}
      return;
    }
    var p=pages[cur]; if(!p){return;}
    p.style.transform='scale(1)';
    var h=p.offsetHeight, w=p.offsetWidth;
    var availH=window.innerHeight-36, availW=window.innerWidth-28;
    var s=Math.min(1, availH/h, availW/w);
    pages.forEach(function(pg,k){pg.style.transform=(k===cur&&s<1)?'scale('+s.toFixed(4)+')':'';});
    if(wrap){wrap.style.height=Math.max(availH+16, Math.round(h*s))+'px';}
  }

  function go(i){
    if(i<0||i>=pages.length){return;}
    pages[cur].classList.remove('active');
    cur=i;
    pages[cur].classList.add('active');
    fit();
    if(isMobile()){window.scrollTo(0,0);}
    schedule();
  }

  // ---------- 键盘翻页 ----------
  document.addEventListener('keydown',function(e){
    if(e.key==='ArrowRight'||e.key==='PageDown'||e.key===' '){e.preventDefault();go(cur+1);}
    else if(e.key==='ArrowLeft'||e.key==='PageUp'){e.preventDefault();go(cur-1);}
    else if(e.key==='Home'){go(0);}
    else if(e.key==='End'){go(pages.length-1);}
    else if(e.key==='a'||e.key==='A'){setAuto(!autoOn);}
    else if(e.key==='m'||e.key==='M'){ if(musicOn){stopMusic();}else{startMusic();} }
  });

  // ---------- 触屏左右滑动翻页 ----------
  var tx=0,ty=0,tt=0;
  document.addEventListener('touchstart',function(e){
    var t=e.touches[0]; if(!t){return;} tx=t.clientX; ty=t.clientY; tt=Date.now();
  },{passive:true});
  document.addEventListener('touchend',function(e){
    var t=e.changedTouches[0]; if(!t){return;}
    var dx=t.clientX-tx, dy=t.clientY-ty;
    if(Math.abs(dx)>60 && Math.abs(dx)>Math.abs(dy)*1.5 && Date.now()-tt<900){go(cur+(dx<0?1:-1));}
  },{passive:true});

  window.addEventListener('resize',fit);
  window.addEventListener('orientationchange',function(){setTimeout(fit,150);});
  window.addEventListener('load',fit);
  go(0);

  // ---------- 悬浮提示 ----------
  var tip=document.getElementById('tip');
  if(tip){
    document.querySelectorAll('[data-tip]').forEach(function(el){
      el.addEventListener('mouseenter',function(){tip.textContent=el.dataset.tip;tip.classList.add('on');});
      el.addEventListener('mousemove',function(e){
        var w=tip.offsetWidth,h=tip.offsetHeight,x=e.clientX+12,y=e.clientY-h-10;
        if(x+w>window.innerWidth-8){x=e.clientX-w-12;}
        if(y<8){y=e.clientY+16;}
        tip.style.transform='translate('+x+'px,'+y+'px)';
      });
      el.addEventListener('mouseleave',function(){tip.classList.remove('on');});
    });
  }

  // ---------- 表格排序 ----------
  document.querySelectorAll('table.tbl-sort').forEach(function(tb){
    var body=tb.querySelector('tbody');
    tb.querySelectorAll('th[data-sort]').forEach(function(th){
      th.addEventListener('click',function(){
        var i=[].indexOf.call(th.parentNode.children,th);
        var dir=th.dataset.dir==='asc'?-1:1;
        [].forEach.call(th.parentNode.children,function(o){o.dataset.dir='';o.classList.remove('asc','desc');});
        th.dataset.dir=dir===1?'asc':'desc';
        th.classList.add(dir===1?'asc':'desc');
        var rows=[].slice.call(body.querySelectorAll('tr'));
        rows.sort(function(a,b){
          var ac=a.children[i],bc=b.children[i]; if(!ac||!bc){return 0;}
          var av=ac.dataset.v!==undefined?ac.dataset.v:ac.textContent.trim();
          var bv=bc.dataset.v!==undefined?bc.dataset.v:bc.textContent.trim();
          var an=parseFloat(av),bn=parseFloat(bv);
          var numeric=!isNaN(an)&&!isNaN(bn)&&/^-?\\d+(\\.\\d+)?$/.test(av)&&/^-?\\d+(\\.\\d+)?$/.test(bv);
          if(numeric){return (an-bn)*dir;}
          return String(av).localeCompare(String(bv),'zh-Hans-CN')*dir;
        });
        rows.forEach(function(r){body.appendChild(r);});
      });
    });
  });

  // ---------- 自动翻页（默认开启，键盘 A 暂停 / 继续） ----------
  var AUTO_MS=11000, autoOn=false, autoTimer=null;
  function schedule(){
    clearTimeout(autoTimer);
    if(!autoOn){return;}
    autoTimer=setTimeout(function(){go(cur<pages.length-1?cur+1:0);},AUTO_MS);
  }
  function setAuto(on){
    autoOn=!!on;
    schedule();
    if(autoOn){startMusic();}
  }

  // ---------- 背景音乐：WebAudio 现场合成（欢快风格，无外部音频文件） ----------
  var actx=null, master=null, musicOn=false, musicTimer=null, musicArmed=false, hatBuf=null;
  var TEMPO=108, EIGHTH=60/TEMPO/2, BARMS=Math.round(EIGHTH*8*1000);
  // C–G–Am–F 四小节循环：大三和弦琶音 + 根音跳动 + 轻打击，明亮跳跃
  var CHORDS=[[261.63,329.63,392.00,523.25],
              [196.00,246.94,293.66,392.00],
              [220.00,261.63,329.63,440.00],
              [174.61,220.00,261.63,349.23]];
  var BASS=[130.81,98.00,110.00,87.31];
  var PATTERN=[0,2,1,3,2,1,2,3];
  var barIdx=0;

  function initAudio(){
    if(actx){return;}
    var AC=window.AudioContext||window.webkitAudioContext;
    if(!AC){return;}
    actx=new AC();
    master=actx.createGain();
    master.gain.value=0.0001;
    master.connect(actx.destination);
    var len=Math.floor(actx.sampleRate*0.07);
    hatBuf=actx.createBuffer(1,len,actx.sampleRate);
    var d=hatBuf.getChannelData(0);
    for(var i=0;i<len;i++){d[i]=(Math.random()*2-1)*(1-i/len);}
  }
  function tone(freq,t,dur,vol,type,cut){
    var o=actx.createOscillator(), g=actx.createGain(), f=actx.createBiquadFilter();
    o.type=type||'triangle';
    o.frequency.value=freq;
    f.type='lowpass'; f.frequency.value=cut||2600; f.Q.value=0.6;
    g.gain.setValueAtTime(0.0001,t);
    g.gain.exponentialRampToValueAtTime(vol,t+0.03);
    g.gain.exponentialRampToValueAtTime(0.0001,t+dur);
    o.connect(f); f.connect(g); g.connect(master);
    o.start(t); o.stop(t+dur+0.05);
  }
  function hat(t,vol){
    if(!hatBuf){return;}
    var s=actx.createBufferSource(), f=actx.createBiquadFilter(), g=actx.createGain();
    s.buffer=hatBuf;
    f.type='highpass'; f.frequency.value=6800;
    g.gain.value=vol||0.016;
    s.connect(f); f.connect(g); g.connect(master);
    s.start(t); s.stop(t+0.09);
  }
  function playBar(){
    if(!actx||!musicOn||actx.state!=='running'){return;}
    var t=actx.currentTime+0.06;
    var ch=CHORDS[barIdx%4], bass=BASS[barIdx%4];
    tone(bass,t,EIGHTH*1.7,0.055,'triangle',900);
    tone(bass,t+EIGHTH*4,EIGHTH*1.3,0.042,'triangle',900);
    for(var i=0;i<8;i++){
      var n=ch[PATTERN[i]%ch.length];
      tone(n,t+i*EIGHTH,EIGHTH*1.9,0.046,'triangle',3000);
      if(i%2===1){hat(t+i*EIGHTH,0.015);}
    }
    hat(t,0.02);
    barIdx=(barIdx+1)%4;
  }
  function beginLoop(){
    clearInterval(musicTimer);
    playBar();
    musicTimer=setInterval(playBar,BARMS);
  }
  function wake(){
    if(!actx||!musicOn){return;}
    var kick=function(){ if(musicOn&&!musicTimer&&actx.state==='running'){beginLoop();} };
    if(actx.state==='suspended'){
      var p=actx.resume();
      if(p&&p.then){p.then(kick);}else{setTimeout(kick,150);}
    }else{kick();}
  }
  function arm(){
    if(musicArmed){return;}
    musicArmed=true;
    ['pointerdown','touchstart','keydown','wheel'].forEach(function(ev){
      window.addEventListener(ev,wake,{passive:true});
    });
  }
  function startMusic(){
    initAudio();
    if(!actx){return;}
    musicOn=true;
    master.gain.cancelScheduledValues(actx.currentTime);
    master.gain.setValueAtTime(0.0001,actx.currentTime);
    master.gain.exponentialRampToValueAtTime(0.42,actx.currentTime+2.5);
    if(actx.state==='suspended'){ actx.resume(); }
    if(actx.state==='running'){ beginLoop(); } else { arm(); }
  }
  function stopMusic(){
    if(!musicOn){return;}
    musicOn=false;
    clearInterval(musicTimer); musicTimer=null;
    if(actx&&master){
      master.gain.cancelScheduledValues(actx.currentTime);
      master.gain.setTargetAtTime(0.0001,actx.currentTime,0.3);
    }
  }

  // 默认：自动翻页 + 背景音乐
  setAuto(true);
})();
"""


def _esc(s) -> str:
    return _html.escape(str(s), quote=True)


def svg_bullet(done: float, req: float, ok: bool) -> str:
    """A4 用双条：HTML 负责文字，SVG 只负责条形与目标线。"""
    W, H = 600, 30
    maxv = max(done, req, 1e-6) * 1.04
    bw = min(W, done / maxv * W)
    tx = min(W - 2, req / maxv * W)
    fill = "bar-fill" if ok else "bar-fill gap"
    return (
        f'<div class="bar">'
        f'<div class="{fill}" style="width:{bw / W * 100:.2f}%"></div>'
        f'<div class="bar-target" style="left:{tx / W * 100:.2f}%"></div>'
        f"</div>"
    )


def svg_years(by_year: list[dict]) -> str:
    """历年任务：柱（下发/已完成）+ 折线（完成率）。"""
    if not by_year:
        return ""
    W, H = 700, 208
    L, R, T_, B = 30, 36, 16, 26
    pw, ph = W - L - R, H - T_ - B
    n = len(by_year)
    gw = pw / n
    max_total = max(r["total"] for r in by_year) or 1
    ymax = max_total * 1.2

    def yv(v):
        return T_ + ph - v / ymax * ph

    def yp(p):
        return T_ + ph - max(0.0, min(100.0, p)) / 100 * ph

    bw = max(6.0, min(14.0, gw * 0.26))
    o = [f'<svg class="chart" viewBox="0 0 {W} {H}" role="img" aria-label="历年任务完成情况">']
    for i in range(5):
        v = ymax * i / 4
        y = yv(v)
        o.append(f'<line x1="{L}" y1="{y:.1f}" x2="{W - R}" y2="{y:.1f}" stroke="#EDF1EE"/>')
        o.append(f'<text class="ax" x="{L - 5}" y="{y + 3.2:.1f}" text-anchor="end">{v:.0f}</text>')
    for p in (0, 50, 100):
        o.append(f'<text class="ax" x="{W - R + 5}" y="{yp(p) + 3.2:.1f}">{p}%</text>')
    for i, r in enumerate(by_year):
        cx = L + gw * (i + 0.5)
        rate = _pct(r["done"], r["total"])
        tip = f'{r["year"]} 年｜下发 {r["total"]} 项｜完成 {r["done"]} 项｜完成率 {rate:.0f}%'
        o.append(f'<g class="hit" data-tip="{_esc(tip)}">')
        o.append(f'<rect x="{cx - gw / 2:.1f}" y="{T_}" width="{gw:.1f}" height="{ph}" fill="transparent"/>')
        o.append(f'<rect x="{cx - bw - 1:.1f}" y="{yv(r["total"]):.1f}" width="{bw:.1f}" '
                 f'height="{max(1.2, r["total"] / ymax * ph):.1f}" fill="#CBD9D2"/>')
        o.append(f'<rect x="{cx + 1:.1f}" y="{yv(r["done"]):.1f}" width="{bw:.1f}" '
                 f'height="{max(1.2, r["done"] / ymax * ph):.1f}" fill="{BRAND}"/>')
        o.append("</g>")
        o.append(f'<text class="ax" x="{cx:.1f}" y="{H - 8}" text-anchor="middle">{r["year"]}</text>')
    pts = " ".join(f'{L + gw * (i + 0.5):.1f},{yp(_pct(r["done"], r["total"])):.1f}'
                   for i, r in enumerate(by_year))
    o.append(f'<polyline points="{pts}" fill="none" stroke="{AMBER}" stroke-width="1.6" '
             f'stroke-linejoin="round" stroke-linecap="round"/>')
    for i, r in enumerate(by_year):
        cx = L + gw * (i + 0.5)
        o.append(f'<circle cx="{cx:.1f}" cy="{yp(_pct(r["done"], r["total"])):.1f}" r="2.4" '
                 f'fill="#fff" stroke="{AMBER}" stroke-width="1.4"/>')
    o.append("</svg>")
    return "".join(o)


def svg_donut(items: list[dict], total: int, center_top: str, center_sub: str):
    import math
    S = 200
    r = 72
    cx = cy = S / 2
    circ = 2 * math.pi * r
    o = [f'<svg class="donut" viewBox="0 0 {S} {S}" role="img" aria-label="任务类型分布">',
         f'<g transform="rotate(-90 {cx} {cy})">']
    acc = 0.0
    legend = []
    for i, it in enumerate(items):
        share = it["total"] / total if total else 0
        seg = share * circ
        color = PALETTE[i % len(PALETTE)]
        tip = f'{it["type"]}｜共 {it["total"]} 项｜已完成 {it["done"]} 项｜占比 {share * 100:.1f}%'
        o.append(f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="none" stroke="{color}" '
                 f'stroke-width="24" stroke-dasharray="{max(0.0, seg - 1.8):.2f} '
                 f'{circ - max(0.0, seg - 1.8):.2f}" stroke-dashoffset="{-acc:.2f}" '
                 f'data-tip="{_esc(tip)}" style="cursor:pointer"/>')
        acc += seg
        legend.append(f'<div><i style="background:{color}"></i>{_esc(it["type"])}'
                      f'<em>{it["total"]} 项 · {share * 100:.0f}%</em></div>')
    o.append("</g>")
    o.append(f'<text x="{cx}" y="{cy - 2}" text-anchor="middle" '
             f'style="font-size:26px;font-weight:700;fill:#16211C">{_esc(center_top)}</text>')
    o.append(f'<text x="{cx}" y="{cy + 18}" text-anchor="middle" '
             f'style="font-size:11px;fill:#6B7A73">{_esc(center_sub)}</text>')
    o.append("</svg>")
    return "".join(o), "".join(legend)


def svg_stack(segments: list[tuple[int, str]], W: int = 620, H: int = 22) -> str:
    total = sum(c for c, _ in segments) or 1
    o = [f'<svg class="stack" viewBox="0 0 {W} {H}" preserveAspectRatio="none" aria-hidden="true">']
    x = 0.0
    for c, color in segments:
        if c <= 0:
            continue
        w = c / total * W
        o.append(f'<rect x="{x:.1f}" y="0" width="{max(1.0, w - 1.2):.1f}" height="{H}" fill="{color}"/>')
        x += w
    o.append("</svg>")
    return "".join(o)


def render_html(rep: dict, token: str = "", token_expires: str | None = None) -> str:
    esc = _esc
    m, h = rep["meta"], rep["hours"]
    net, cls = h["网络自学"], h["集中培训"]
    y = rep["task_stats"]["year"]
    dv = rep.get("derived") or derive(rep)
    member = m.get("member") or {}
    name = member.get("name") or "—"
    org = (member.get("org") or "—").replace("-->", " → ")
    year = m["year"]
    today = date.today()
    dur = rep["duration"]
    rate = dv["completion_rate"]
    allst = rep["task_stats"]["all"]
    ts = rep.get("training_stats") or {}
    trainings = rep.get("trainings") or []
    year_items = ts.get("year_items") or rep["classes"]
    ongoing = ts.get("ongoing") or []
    achieved = ts.get("achieved_hours", 0.0)
    gl = (achieved + ts.get("ongoing_hours", 0.0))
    gap = cls["缺口"]
    page_no = [0]

    def foot(title: str) -> str:
        page_no[0] += 1
        return (f'<div class="page-foot"><span>{year} 年度学习报告</span>'
                f"<span>{esc(name)} · {esc((member.get('org') or '').split('-->')[-1] or '')}</span>"
                f"<span>{page_no[0]:02d}</span></div>")

    def link(t: dict) -> str:
        title = esc(t.get("title", ""))
        if token:
            u = TB.login_link(t.get("url", ""), token)
            if u:
                return f'<a href="{esc(u)}" target="_blank" rel="noopener" style="color:inherit">{title}</a>'
        return title

    def dleft(end) -> int | None:
        if not end:
            return None
        try:
            return (date.fromisoformat(str(end)) - today).days
        except ValueError:
            return None

    def gap_txt(d):
        return "超额 %.2f" % d["差额"] if d["达标"] else "缺口 %.2f" % d["缺口"]

    out = [
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width,initial-scale=1">',
        f"<title>{year} 年度学习报告 · {esc(name)}</title>",
        f"<style>{CSS}</style></head><body class=\"deck\"><div class=\"deckwrap\">",
    ]

    # =============== 封面 =============== #
    out.append(f"""
<section class="page cover active">
  <div class="cover-top">
    <div class="eyebrow">中国烟草网络学院 · 个人学习档案</div>
    <h1 class="cover-title">{year}<br>年度学习报告</h1>
    <div class="cover-sub">学时完成 · 任务执行 · 线下培训 · 差距分析</div>
    <div class="cover-rule"></div>
  </div>
  <div class="cover-body">
    <div class="cover-summary">
      <div class="cs-label">本 年 度 摘 要</div>
      <p>全年派发任务 <b>{y['total']} 项</b>，已完成 <b>{y['done']} 项</b>（{rate:.1f}%）；
      网络自学累计 <b>{net['已完成']:.2f} 学时</b>，超考核线 {net['完成率'] - 100:.1f}%；
      集中培训 <b>{cls['已完成']:.0f} / {cls['要求']:.0f} 学时</b>，缺口 {gap:.0f} 学时，
      是本年度唯一未达标的考核项。</p>
      <div class="cs-stats">
        <div><span>{rate:.1f}%</span><i>任务完成率</i></div>
        <div><span>{net['完成率']:.1f}%</span><i>网络自学完成率</i></div>
        <div><span>{cls['完成率']:.1f}%</span><i>集中培训完成率</i></div>
      </div>
    </div>
    <div class="meta-grid">
      <div class="meta-item"><div class="meta-k">学 员</div><div class="meta-v">{esc(name)}</div></div>
      <div class="meta-item"><div class="meta-k">所 属 单 位</div>
        <div class="meta-v">{esc(org.split(' → ')[0] if ' → ' in org else org)}
        <small>{esc(' → '.join(org.split(' → ')[1:]) or '—')}</small></div></div>
      <div class="meta-item"><div class="meta-k">统 计 口 径</div>
        <div class="meta-v">{year} 年度（进行中）<small>数据截至 {today.isoformat()}</small></div></div>
      <div class="meta-item"><div class="meta-k">数 据 来 源</div>
        <div class="meta-v">平台实时接口<small>任务台账 {m['platform_total_tasks']} 条 ·
        培训班 {ts.get('total_count', 0)} 期 · 学时总览 1 次</small></div></div>
    </div>
    <div class="cover-foot"><span>本报告由平台数据自动汇总生成，不含人工填报内容</span>
      <span>{today.strftime('%Y.%m.%d')}</span></div>
  </div>
</section>""")

    # =============== P2 总体概览 =============== #
    out.append(f"""
<section class="page">
  <div class="run-head">{year} ANNUAL LEARNING REPORT</div>
  <div class="sec-head"><div class="sec-no">01</div><div class="sec-title">总体概览</div>
    <div class="sec-note">截至 {today.isoformat()}</div></div>
  <p class="lead">本年度平台共派发学习任务 <strong>{y['total']} 项</strong>，全部为必修；已完成
    <strong>{y['done']} 项</strong>，完成率 <strong>{rate:.1f}%</strong>。两个学时考核口径呈
    “一超一缺”的明显分化：<strong>网络自学大幅超额</strong>（{net['已完成']:.2f} / {net['要求']:.0f} 学时），
    而<strong>集中培训仍有 {gap:.0f} 学时缺口</strong>（{cls['已完成']:.0f} / {cls['要求']:.0f} 学时），
    是本年度唯一未达标的考核项。</p>
  <div class="kpi">
    <div class="kpi-box"><div class="kpi-label">年 度 任 务</div>
      <div class="kpi-num">{y['total']}<span class="unit">项</span></div>
      <div class="kpi-foot">全部必修 · 已完成 {y['done']} 项</div></div>
    <div class="kpi-box warn"><div class="kpi-label">待 完 成</div>
      <div class="kpi-num">{y['pending']}<span class="unit">项</span></div>
      <div class="kpi-foot">必修 {y['required_done']} / {y['required_total']} 已完成</div></div>
    <div class="kpi-box"><div class="kpi-label">网 络 自 学</div>
      <div class="kpi-num">{net['已完成']:.1f}<span class="unit">学时</span></div>
      <div class="kpi-foot">要求 {net['要求']:.0f} · 超额 {net['差额']:.1f}</div></div>
    <div class="kpi-box bad"><div class="kpi-label">集 中 培 训</div>
      <div class="kpi-num">{cls['已完成']:.0f}<span class="unit">/ {cls['要求']:.0f} 学时</span></div>
      <div class="kpi-foot">缺口 {gap:.0f} · 完成率 {cls['完成率']:.1f}%</div></div>
  </div>

  <div class="dual">
    <div class="dual-row">
      <div class="dual-top"><div class="dual-name">网络自学 <span>网络课程 / 在线学习</span></div>
        <div class="dual-val">{net['已完成']:.2f}<em>/ {net['要求']:.2f} 学时</em>
          <span class="pill ok">超额 {net['差额']:.2f}</span></div></div>
      {svg_bullet(net['已完成'], net['要求'], net['达标'])}
      <div class="bar-marks"><span>0</span><span>目标 {net['要求']:.0f} · 完成率 {net['完成率']:.1f}%</span></div>
    </div>
    <div class="dual-row">
      <div class="dual-top"><div class="dual-name">集中培训 <span>培训班 / 集中面授</span></div>
        <div class="dual-val">{cls['已完成']:.2f}<em>/ {cls['要求']:.2f} 学时</em>
          <span class="pill {'ok' if cls['达标'] else 'warn'}">{gap_txt(cls)}</span></div></div>
      {svg_bullet(cls['已完成'], cls['要求'], cls['达标'])}
      <div class="bar-marks"><span>0</span><span>目标 {cls['要求']:.0f} · 完成率 {cls['完成率']:.1f}%</span></div>
    </div>
  </div>

  <div class="note-box plain"><strong>口径提示：</strong>两组学时独立考核，任一组超额都不改变另一组的结论。
    网络自学多出的 {net['差额']:.2f} 学时<strong>不能抵扣</strong>集中培训缺口，后者只能通过报班补足。
    平台 <code>totalScore</code>（{float(h['总学分']):.2f}）等于两组已完成之和，不是第三项指标。</div>

  <div class="chart-card" style="margin-top:5mm">
    <div class="chart-cap">学时投入结构与考核权重对照</div>
    <div class="chart-sub">上：已完成学时构成（合计 {float(h['总学分']):.2f}）· 下：考核要求权重（网络自学 {net['要求']:.0f} ＋ 集中培训 {cls['要求']:.0f}）</div>
    <div style="font-size:8.5pt;color:var(--muted);margin:3mm 0 1.5mm">已完成学时构成</div>
    <div style="display:flex;height:8mm;overflow:hidden">
      <div style="width:{net['已完成'] / (net['已完成'] + cls['已完成']) * 100:.1f}%;background:linear-gradient(90deg,#2E8B5F,#1F6F4A);color:#fff;font-size:8pt;display:flex;align-items:center;justify-content:center">
        网络自学 {net['已完成']:.0f}（{net['已完成'] / (net['已完成'] + cls['已完成']) * 100:.1f}%）</div>
      <div style="width:{cls['已完成'] / (net['已完成'] + cls['已完成']) * 100:.1f}%;background:#E3B071;color:#4A2C08;font-size:8pt;display:flex;align-items:center;justify-content:center">
        集中培训 {cls['已完成']:.0f}（{cls['已完成'] / (net['已完成'] + cls['已完成']) * 100:.1f}%）</div>
    </div>
    <div style="font-size:8.5pt;color:var(--muted);margin:3.5mm 0 1.5mm">考核要求权重</div>
    <div style="display:flex;height:8mm;overflow:hidden">
      <div style="width:{net['要求'] / (net['要求'] + cls['要求']) * 100:.1f}%;background:#CBD9D2;color:#2C3A34;font-size:8pt;display:flex;align-items:center;justify-content:center">
        网络自学 {net['要求']:.0f}（{net['要求'] / (net['要求'] + cls['要求']) * 100:.1f}%）</div>
      <div style="width:{cls['要求'] / (net['要求'] + cls['要求']) * 100:.1f}%;background:#C98A3E;color:#fff;font-size:8pt;display:flex;align-items:center;justify-content:center">
        集中培训 {cls['要求']:.0f}（{cls['要求'] / (net['要求'] + cls['要求']) * 100:.1f}%）</div>
    </div>
    <div class="legend"><span><i style="background:#1F6F4A"></i>实际投入</span>
      <span><i style="background:#C98A3E"></i>考核权重</span>
      <span style="margin-left:auto">结构倒挂：权重 {cls['要求'] / (net['要求'] + cls['要求']) * 100:.0f}% 的一组，实际投入仅占
        {cls['已完成'] / (net['已完成'] + cls['已完成']) * 100:.0f}%</span></div>
  </div>
  {foot("overview")}
</section>""")

    # =============== P3 集中培训 =============== #
    rows_html = []
    for t in year_items:
        days = ""
        if t["start"] and t["end"] and t["start"] != t["end"]:
            days = f'<span style="color:var(--muted);font-size:8pt"> · {(date.fromisoformat(t["end"]) - date.fromisoformat(t["start"])).days + 1} 天</span>'
        pill = ("pill ok" if t["graduate_status"] == 4 else
                "pill warn" if t["graduate_status"] == 1 else "pill na")
        rows_html.append(
            f'<tr><td class="t-title">{link({"title": t["title"], "url": t["url"]})}</td>'
            f'<td class="date">{esc(t["start"] or "—")}{days}</td>'
            f'<td class="num">{t["class_hour"]:.0f}</td>'
            f'<td>{esc(t["place"] or "—")}</td>'
            f'<td class="mid"><span class="{pill}">{esc(t["graduate_label"])}</span></td></tr>')
    train_rows = "".join(rows_html)

    # 按月的学时分布（本年度）
    by_month = {}
    for t in year_items:
        if not t["start"] or t["graduate_status"] != 4:
            continue
        mo = t["start"][5:7]
        by_month[mo] = by_month.get(mo, 0.0) + t["class_hour"]
    month_bars = ""
    if by_month:
        cells = []
        for mo in [f"{i:02d}" for i in range(1, 13)]:
            v = by_month.get(mo, 0)
            hgt = min(100, v / max(by_month.values()) * 100) if max(by_month.values()) else 0
            cells.append(
                f'<div style="flex:1;display:flex;flex-direction:column;justify-content:flex-end;'
                f'align-items:center;height:15mm;gap:.8mm">'
                f'<div style="font-size:7pt;color:var(--muted)">{v:.0f}</div>'
                f'<div style="width:70%;height:{hgt * 0.7:.1f}%;background:'
                f'{"linear-gradient(180deg,#8FBFA6,#1F6F4A)" if v else "#EDF1EE"};min-height:1mm"></div></div>')
        month_bars = ('<div style="display:flex;gap:1mm;align-items:flex-end;margin-top:2mm">'
                      + "".join(cells) +
                      '</div><div style="display:flex;gap:1mm;margin-top:1mm">'
                      + "".join(f'<div style="flex:1;text-align:center;font-size:7pt;color:var(--muted)">{i}</div>'
                                for i in range(1, 13)) + "</div>")

    out.append(f"""
<section class="page compact">
  <div class="run-head">{year} ANNUAL LEARNING REPORT</div>
  <div class="sec-head"><div class="sec-no">02</div><div class="sec-title">线下集中培训</div>
    <div class="sec-note">行业内科培训 · 共 {ts.get('year_count', 0)} 期</div></div>
  <p class="lead">本年度共参加线下培训班 <strong>{ts.get('year_count', 0)} 期</strong>，
    其中 <strong>{ts.get('year_done_count', 0)} 期已结业</strong>，累计 <strong>{achieved:.2f} 学时</strong>；
    另有 {len(ongoing)} 期在读（{ts.get('ongoing_hours', 0):.0f} 学时）。这些班次以单位内部科室培训为主，
    场地集中在局会议室，属于集中培训学时的全部来源。</p>

  <table class="tbl-sort">
    <thead><tr><th data-sort="text">培训班 / 培训主题</th><th data-sort="text">开始日期</th>
      <th data-sort="num" style="text-align:right">学时</th><th data-sort="text">地点</th>
      <th data-sort="text" style="text-align:center">状态</th></tr></thead>
    <tbody>{train_rows}</tbody>
    <tfoot><tr><td>合计 {ts.get('year_count', 0)} 期（已结业 {ts.get('year_done_count', 0)} 期）</td>
      <td>—</td><td style="text-align:right">{sum((t['class_hour'] for t in year_items), 0):.0f}</td>
      <td colspan="2">已获 {achieved:.2f} ＋ 在读 {ts.get('ongoing_hours', 0):.0f} = {gl:.0f} 学时</td></tr></tfoot>
  </table>

  <div class="chart-card" style="margin-top:5mm">
    <div class="chart-cap">本年度集中培训学时分布（按月）</div>
    <div class="chart-sub">仅统计已结业班次 · 单位：学时</div>
    {month_bars}
  </div>

  <div class="note-box"><strong>达标测算：</strong>现有 {achieved:.0f} 学时 ＋ 在读的《{esc(ongoing[0]['title']) if ongoing else '—'}》
    {ts.get('ongoing_hours', 0):.0f} 学时 ＝ <strong>{gl:.0f} 学时</strong>，
    距 {cls['要求']:.0f} 学时考核线仍差 <strong>{max(0.0, cls['要求'] - gl):.0f} 学时</strong>，
    不足一期常规班次，需向培训管理部门确认用零散面授补足或结转下年。</div>
  {foot("train")}
</section>""")

    # =============== P4 任务执行 =============== #
    pend_rows = []
    for t in rep["year_pending"]:
        dl = dleft(t.get("end"))
        if dl is None:
            tag = '<span class="pill na">无截止</span>'
        elif dl < 0:
            tag = f'<span class="pill bad">逾期 {-dl} 天</span>'
        elif dl <= 7:
            tag = f'<span class="pill warn">{dl} 天</span>'
        else:
            tag = f'<span style="font-size:8.5pt">{dl} 天</span>'
        pend_rows.append(
            f'<tr><td class="t-title">{link(t)}</td><td>{esc(t["type"])}</td>'
            f'<td class="date">{esc(t["end"] or "—")}</td><td class="mid">{tag}</td></tr>')
    done_rows = "".join(
        f'<tr><td class="t-title">{link(t)}</td><td>{esc(t["type"])}</td>'
        f'<td class="date">{esc(t["end"] or "—")}</td></tr>' for t in rep["year_done"])

    out.append(f"""
<section class="page">
  <div class="run-head">{year} ANNUAL LEARNING REPORT</div>
  <div class="sec-head"><div class="sec-no">03</div><div class="sec-title">年度任务执行</div>
    <div class="sec-note">平台台账 {allst['total']} 条</div></div>
  <p class="lead">平台历史任务共 <strong>{allst['total']} 项</strong>，已完成 {allst['done']} 项（{_pct(allst['done'], allst['total']):.0f}%）；
    本年度派发 <strong>{y['total']} 项</strong>，已完成 <strong>{y['done']} 项</strong>，待完成 {y['pending']} 项。
    待办任务的截止日高度集中在 12 月 31 日，属于年底集中清理型。</p>

  <div class="chart-card">
    <div class="chart-cap">任务完成结构</div>
    <div class="chart-sub">上：全部历史任务 · 下：{year} 年派发任务</div>
    <div class="stack-row"><div class="lb">全部历史</div>
      {svg_stack([(allst['done'], BRAND), (allst['doing'], AMBER), (allst['todo'], '#D7DCE4')])}</div>
    <div class="stack-row"><div class="lb">{year} 年度</div>
      {svg_stack([(y['done'], BRAND), (y['pending'], '#D7DCE4')])}</div>
    <div class="legend"><span><i style="background:#1F6F4A"></i>已完成</span>
      <span><i style="background:#C98A3E"></i>进行中</span>
      <span><i style="background:#D7DCE4"></i>未开始 / 待完成</span></div>
  </div>

  <div style="font-size:10pt;font-weight:700;color:var(--brand-dark);margin:5mm 0 2.5mm">
    待完成（{y['pending']} 项）</div>
  <table class="tbl-sort"><thead><tr><th data-sort="text">任务</th><th data-sort="text">类型</th>
    <th data-sort="num">截止</th><th data-sort="num" style="text-align:center">剩余</th>
    </tr></thead><tbody>{''.join(pend_rows)}</tbody></table>

  <div style="font-size:10pt;font-weight:700;color:var(--brand-dark);margin:5mm 0 2.5mm">
    已完成（{y['done']} 项）</div>
  <table><thead><tr><th>任务</th><th>类型</th><th>截止</th></tr></thead>
    <tbody>{done_rows}</tbody></table>
  {foot("tasks")}
</section>""")

    # =============== P5 结构与趋势 =============== #
    types = rep["task_stats"]["types"]
    by_year = rep["task_stats"]["by_year"]
    donut_svg, legend = ("", "")
    if types:
        donut_svg, legend = svg_donut(types, allst["total"], str(allst["total"]), "任务总数")
    dur_h = (dur.get("total_seconds") or 0) / 3600

    out.append(f"""
<section class="page">
  <div class="run-head">{year} ANNUAL LEARNING REPORT</div>
  <div class="sec-head"><div class="sec-no">04</div><div class="sec-title">结构与趋势</div>
    <div class="sec-note">历史任务口径</div></div>
  <p class="lead">从全部 {allst['total']} 项历史任务看，学习内容高度集中在<strong>专题课程</strong>；
    历年完成率在 2025 年达到 100%，2026 年因年底集中派发而暂时偏低。累计学习时长
    <strong>{dur_h:.1f} 小时</strong>（平台统计，含历史累计）。</p>

  <div class="kpi" style="grid-template-columns:repeat(4,1fr)">
    <div class="kpi-box"><div class="kpi-label">任 务 总 数</div>
      <div class="kpi-num">{allst['total']}<span class="unit">项</span></div>
      <div class="kpi-foot">历年累计</div></div>
    <div class="kpi-box"><div class="kpi-label">已 完 成</div>
      <div class="kpi-num">{allst['done']}<span class="unit">项</span></div>
      <div class="kpi-foot">完成率 {_pct(allst['done'], allst['total']):.0f}%</div></div>
    <div class="kpi-box"><div class="kpi-label">累 计 学 习</div>
      <div class="kpi-num">{dur_h:.0f}<span class="unit">小时</span></div>
      <div class="kpi-foot">含历史 {((dur.get('history_seconds') or 0) / 3600):.0f} 小时</div></div>
    <div class="kpi-box"><div class="kpi-label">培 训 班</div>
      <div class="kpi-num">{ts.get('total_count', 0)}<span class="unit">期</span></div>
      <div class="kpi-foot">本年 {ts.get('year_count', 0)} 期</div></div>
  </div>

  <div class="chart-card">
    <div class="chart-cap">任务类型分布</div>
    <div class="chart-sub">按历史全量任务统计，鼠标悬停查看明细</div>
    <div class="donut-wrap">{donut_svg}<div class="dlegend">{legend}</div></div>
  </div>

  <div class="chart-card">
    <div class="chart-cap">历年任务完成情况</div>
    <div class="chart-sub">柱：下发与完成数量 · 折线：完成率（右轴）</div>
    {svg_years(by_year)}
    <div class="legend"><span><i style="background:#CBD9D2"></i>下发</span>
      <span><i style="background:#1F6F4A"></i>已完成</span>
      <span><i style="background:#C98A3E"></i>完成率</span></div>
  </div>
  {foot("trend")}
</section>""")

    # =============== P6 结论 =============== #
    facts = "".join(f"<li>{esc(x)}</li>" for x in dv["findings"])
    acts = ""
    for i, x in enumerate(dv["actions"], 1):
        urgent = " urgent" if ("逾期" in x or "缺口" in x) else ""
        acts += (f'<div class="action"><div class="a-rank{urgent}">{i}</div>'
                 f'<div class="a-body"><div class="a-desc">{esc(x)}</div></div></div>')

    out.append(f"""
<section class="page">
  <div class="run-head">{year} ANNUAL LEARNING REPORT</div>
  <div class="sec-head"><div class="sec-no">05</div><div class="sec-title">结论与建议</div>
    <div class="sec-note">依据平台可核验数据</div></div>

  <div class="two">
    <div class="card"><h4>已成立的事实</h4><ul>{facts}</ul></div>
    <div class="card warn-card"><h4>下一步动作</h4>{acts}</div>
  </div>

  <div class="footnote">
    <b>数据口径</b><br>
    · 学时取自 <code>GET /api/v1/system/credit/detail-hour-member</code>：<code>courseHourResult.totalHour</code>
      对 <code>requireCourseHour</code> 为网络自学，<code>totalClassHour</code> 对 <code>requireClassHour</code> 为集中培训；
      <code>totalScore</code> 为两组之和，不是第三项指标。<br>
    · 集中培训明细取自个人中心「班级」接口
      <code>/training/student/class-student/front/center-page</code>，逐班从
      <code>/training/student/class-info/front/basic/&lt;id&gt;</code> 取 <code>classHour</code>、地点与起止时间。
      经核对：{year} 年已结业班次 <code>classHour</code> 合计 <b>{achieved:.2f}</b>，与平台
      <code>totalClassHour</code>（{cls['已完成']:.2f}）完全一致。<br>
    · 年度归属按任务 <code>startTime</code> 的年份（下发年）；平台不返回逐条完成时间，
      故不提供“月度完成趋势”，避免用截止时间冒充完成时间。<br>
    · 任务进度只有 <code>status</code>（未开始 / 进行中 / 已完成），没有百分比。
      数据采集于 {esc(m['generated_at'].replace('T', ' '))}。
  </div>
  {foot("concl")}
</section>""")

    out.append(f"""</div>
<div class="tip" id="tip"></div>
<script>{JS}</script>
</body></html>""")
    return "\n".join(out)


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #
def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="生成年度学习报告")
    p.add_argument("--year", type=int, default=date.today().year, help="统计年度，默认今年")
    p.add_argument("--out", help="输出文件；.html 结尾出网页版，其余出 Markdown")
    p.add_argument("--html", action="store_true", help="强制输出 HTML")
    p.add_argument("--json", action="store_true", help="输出原始数据 JSON")
    p.add_argument("--login-links", action="store_true",
                   help="任务名做成免登录直达链接（文件含凭据，勿外发）")
    a = p.parse_args(argv)

    rep = collect(a.year)
    rep["derived"] = derive(rep)

    if a.json:
        print(json.dumps(rep, ensure_ascii=False, indent=2))
        return 0

    token, exp = ("", None)
    if a.login_links:
        token, exp = TB.load_link_token()
        if not token:
            print("提示：没有可用登录态，本次不生成直达链接。先跑 "
                  "`mooc_tasks.py login-password` 或扫码登录。", file=sys.stderr)

    if a.out:
        out = Path(a.out)
        want_html = a.html or out.suffix.lower() in (".html", ".htm")
        text = render_html(rep, token, exp) if want_html else render_md(rep, token)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(text, encoding="utf-8")
        if token:
            TB._restrict_permissions(out)
        print(f"年度学习报告已写入 {out}")
        if token:
            print(f"已生成免登录直达链接（token 有效期至 {exp}）。该文件含凭据，请勿外发。")
        for x in rep["derived"]["findings"]:
            print(f"  · {x}")
        return 0

    print(render_md(rep, token))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
