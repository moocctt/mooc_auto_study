#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""中国烟草网络学院（mooc.ctt.cn）学习任务的本地管理与排期工具。

职责边界：
  - 只做本地持久化、优先级计算、排期生成与导出。
  - 不访问网络、不驱动浏览器、不自动播放课程。
    页面采集与登录由 agent 通过浏览器工具完成，结果经 `task import` 落库。

数据默认存放在 <skill>/data 下，可用环境变量 TOBACCO_HOME 覆盖（便于测试）。
"""

from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import json
import os
import re
import subprocess
import sys
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import quote

if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # pragma: no cover
        pass

SKILL_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("TOBACCO_HOME") or (SKILL_ROOT / "data"))
TASKS_FILE = DATA_DIR / "tasks.json"
CRED_FILE = DATA_DIR / "credentials.dat"
BASE_URL = "https://mooc.ctt.cn"      # 生成免登录直达链接用
SCHEMA_VERSION = 1

KIND_ALIASES = {
    "course": "course", "课程": "course", "视频": "course", "点播": "course",
    "live": "live", "直播": "live", "回看": "live",
    "exam": "exam", "考试": "exam", "测验": "exam", "测试": "exam", "考核": "exam",
    "survey": "survey", "问卷": "survey", "评估": "survey", "评价": "survey",
    "class_task": "class_task", "班级任务": "class_task", "活动": "class_task",
    "other": "other", "其他": "other",
}
KIND_LABEL = {
    "course": "课程", "live": "直播", "exam": "考试",
    "survey": "问卷", "class_task": "集中培训", "other": "其他",
}
KIND_BONUS = {"exam": 120, "live": 90, "class_task": 60, "course": 40, "survey": 20, "other": 0}

# 学时分两组考核，**不可互相抵扣**（平台字段见 references/task-api.md）：
#   网络自学 = courseHourResult.totalHour / requireCourseHour
#   集中培训 = totalClassHour            / requireClassHour
# 班级（businessType=5）计集中培训，且是**固定日程的线下培训**，不能像网课那样
# 拆成"每晚 1 小时"，所以排期时不占每日自学容量，单独作为日程列出。
CREDIT_GROUPS = ("网络自学", "集中培训")
KIND_CREDIT_GROUP = {
    "class_task": "集中培训", "course": "网络自学", "live": "网络自学",
    "exam": "网络自学", "survey": "网络自学", "other": "网络自学",
}


def normalize_credit_group(value: Any, kind: str) -> str:
    v = str(value or "").strip()
    if v in CREDIT_GROUPS:
        return v
    return KIND_CREDIT_GROUP.get(kind, "网络自学")
STATUSES = ("todo", "doing", "done")
PROFILE_FILE = DATA_DIR / "profile.json"

# 在职工作状态档位。核心事实：用户是**在职员工，工作日上班时间不可学习**，
# 只有下班后与周末可安排，因此工作日与周末必须取不同的每日容量。
WORK_PROFILES = {
    "office": {
        "label": "在职坐班（工作日上班，仅晚间可学）",
        "weekday_hours": 1.0, "weekend_hours": 3.0,
        "note": "工作日白天在岗不排学习；仅安排下班后少量学时，周末集中补进度",
    },
    "overtime": {
        "label": "加班 / 出差旺季",
        "weekday_hours": 0.5, "weekend_hours": 2.0,
        "note": "工作日几乎不可学，以周末为主",
    },
    "leave": {
        "label": "休假 / 脱产培训",
        "weekday_hours": 4.0, "weekend_hours": 4.0,
        "note": "全周可集中学习",
    },
    "shift": {
        "label": "轮班制",
        "weekday_hours": 1.5, "weekend_hours": 1.5,
        "note": "作息不固定，按平均可支配学时保守安排",
    },
    "flat": {
        "label": "统一每日学时",
        "weekday_hours": 2.0, "weekend_hours": 2.0,
        "note": "不区分工作日与周末",
    },
}
PRIORITY_STRATEGIES = ("layered", "required-first", "deadline-first")
DEFAULT_PROFILE = "office"
DEFAULT_PRIORITY = "layered"


# --------------------------------------------------------------------------- #
# 基础工具
# --------------------------------------------------------------------------- #
def now_iso() -> str:
    return datetime.now().replace(microsecond=0).isoformat()


def ensure_dir() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)


def load_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        raise SystemExit(f"读取 {path} 失败：{exc}\n请检查文件是否损坏，或删除后重新生成。")


def save_json(path: Path, obj: Any) -> None:
    ensure_dir()
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def load_profile() -> dict:
    """读取持久化的在职工作状态；没有配置时回落到 office 档。"""
    saved = load_json(PROFILE_FILE, {}) or {}
    name = saved.get("work_profile") or DEFAULT_PROFILE
    if name not in WORK_PROFILES:
        name = DEFAULT_PROFILE
    base = dict(WORK_PROFILES[name])
    base["work_profile"] = name
    base["weekday_hours"] = float(saved.get("weekday_hours", base["weekday_hours"]))
    base["weekend_hours"] = float(saved.get("weekend_hours", base["weekend_hours"]))
    base["priority"] = saved.get("priority") or DEFAULT_PRIORITY
    if base["priority"] not in PRIORITY_STRATEGIES:
        base["priority"] = DEFAULT_PRIORITY
    base["note"] = saved.get("note", base.get("note", ""))
    base["updated_at"] = saved.get("updated_at")
    return base


def save_profile(work_profile: str | None = None, weekday_hours: float | None = None,
                 weekend_hours: float | None = None, priority: str | None = None,
                 note: str | None = None) -> dict:
    cur = load_profile()
    name = work_profile or cur["work_profile"]
    if name not in WORK_PROFILES:
        raise SystemExit(f"未知工作档位：{name}；可选 {', '.join(WORK_PROFILES)}")
    # 换档时取该档内置值；仅覆盖本次显式给出的字段
    new = {
        "work_profile": name,
        "weekday_hours": (WORK_PROFILES[name]["weekday_hours"]
                          if work_profile else cur["weekday_hours"]),
        "weekend_hours": (WORK_PROFILES[name]["weekend_hours"]
                          if work_profile else cur["weekend_hours"]),
        "priority": priority or cur["priority"],
        "note": note if note is not None else WORK_PROFILES[name]["note"],
        "updated_at": now_iso(),
    }
    if priority and priority not in PRIORITY_STRATEGIES:
        raise SystemExit(f"未知优先级策略：{priority}；可选 {', '.join(PRIORITY_STRATEGIES)}")
    if weekday_hours is not None:
        new["weekday_hours"] = float(weekday_hours)
    if weekend_hours is not None:
        new["weekend_hours"] = float(weekend_hours)
    if new["weekday_hours"] < 0 or new["weekend_hours"] < 0:
        raise SystemExit("每日学时不能为负数。")
    save_json(PROFILE_FILE, new)
    return load_profile()


def day_capacity(profile: dict, d: date) -> float:
    """周末（周六/周日）与工作日取不同的每日可投入学时。"""
    return float(profile["weekend_hours"] if d.weekday() >= 5
                 else profile["weekday_hours"])


def parse_date(value: Any) -> date | None:
    """宽松解析日期，支持 2026-11-20 / 2026/11/20 / 2026.11.20 / 2026年11月20日 / 带时间。"""
    if value in (None, "", "null", "无", "不限", "-"):
        return None
    if isinstance(value, date):
        return value
    text = str(value).strip()
    m = re.search(r"(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})", text)
    if m:
        y, mo, d = (int(x) for x in m.groups())
        try:
            return date(y, mo, d)
        except ValueError:
            return None
    return None


def to_float(value: Any, default: float = 0.0) -> float:
    if value in (None, ""):
        return default
    m = re.search(r"-?\d+(?:\.\d+)?", str(value))
    return float(m.group()) if m else default


def to_progress(value: Any) -> int:
    """把 '45%' / 45 / '已完成' 归一为 0-100 的整数。"""
    if value is None:
        return 0
    if isinstance(value, (int, float)):
        return max(0, min(100, int(value)))
    text = str(value).strip()
    if text in ("已完成", "完成", "已学完", "通过", "已通过"):
        return 100
    if text in ("未开始", "未学习", "未完成", ""):
        return 0
    m = re.search(r"(\d+(?:\.\d+)?)", text)
    if not m:
        return 0
    num = float(m.group(1))
    if "%" in text:
        return max(0, min(100, int(round(num))))
    return max(0, min(100, int(round(num))))


def task_id(title: str, class_name: str = "") -> str:
    raw = f"{class_name.strip()}|{title.strip()}".lower()
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:10]


def normalize_kind(value: Any) -> str:
    text = str(value or "").strip().lower()
    return KIND_ALIASES.get(text, "other")


# --------------------------------------------------------------------------- #
# 凭据：Windows 用 DPAPI 加密，其他平台降级并明确告知
# --------------------------------------------------------------------------- #
def _dpapi(protect: bool, data: bytes) -> bytes:
    import ctypes
    from ctypes import wintypes

    class BLOB(ctypes.Structure):
        _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]

    if not data:
        data = b" "
    buf = ctypes.create_string_buffer(data, len(data))
    blob_in = BLOB(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))
    blob_out = BLOB()
    crypt32 = ctypes.windll.crypt32  # type: ignore[attr-defined]

    if protect:
        fn = crypt32.CryptProtectData
        fn.argtypes = [ctypes.POINTER(BLOB), wintypes.LPCWSTR, ctypes.POINTER(BLOB),
                       ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(BLOB)]
    else:
        fn = crypt32.CryptUnprotectData
        fn.argtypes = [ctypes.POINTER(BLOB), ctypes.POINTER(wintypes.LPWSTR), ctypes.POINTER(BLOB),
                       ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(BLOB)]
    fn.restype = wintypes.BOOL

    if not fn(ctypes.byref(blob_in), None, None, None, None, 0, ctypes.byref(blob_out)):
        raise OSError("DPAPI 调用失败")
    try:
        return ctypes.string_at(blob_out.pbData, blob_out.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(blob_out.pbData)  # type: ignore[attr-defined]


def _protect(secret: str) -> tuple[str, bytes]:
    if sys.platform == "win32":
        try:
            return "dpapi", _dpapi(True, secret.encode("utf-8"))
        except Exception:
            pass
    try:  # 可选：系统钥匙串
        import keyring  # type: ignore

        keyring.set_password("tobacco-mooc-study", "password", secret)
        return "keyring", b""
    except Exception:
        return "plain", secret.encode("utf-8")


def _unprotect(enc: str, secret_b64: str) -> str:
    if enc == "keyring":
        import keyring  # type: ignore

        # skill 改名（tobacco-mooc → tobacco-mooc-study）后仍能读回旧条目
        for service in ("tobacco-mooc-study", "tobacco-mooc"):
            value = keyring.get_password(service, "password")
            if value:
                return value
        return ""
    raw = base64.b64decode(secret_b64.encode("ascii")) if secret_b64 else b""
    if enc == "dpapi":
        return _dpapi(False, raw).decode("utf-8")
    return raw.decode("utf-8")


def _restrict_permissions(path: Path) -> None:
    """尽量把文件权限收窄到当前用户，失败不影响主流程。"""
    try:
        if sys.platform == "win32":
            user = os.environ.get("USERNAME", "")
            if user:
                subprocess.run(
                    ["icacls", str(path), "/inheritance:r", "/grant:r", f"{user}:F"],
                    capture_output=True, check=False, timeout=15,
                )
        else:
            path.chmod(0o600)
    except Exception:
        pass


def cmd_cred(args: argparse.Namespace) -> int:
    if args.action == "clear":
        if CRED_FILE.exists():
            CRED_FILE.unlink()
        try:
            import keyring  # type: ignore

            for service in ("tobacco-mooc-study", "tobacco-mooc"):
                try:
                    keyring.delete_password(service, "password")
                except Exception:
                    pass
        except Exception:
            pass
        print("已清除本地保存的账号凭据。")
        return 0

    if args.action == "get":
        if not CRED_FILE.exists():
            if args.json:
                print(json.dumps({"saved": False}, ensure_ascii=False))
            else:
                print("本地未保存凭据。请让用户在登录时直接输入账号密码。")
            return 1
        obj = load_json(CRED_FILE, {})
        out = {
            "saved": True,
            "username": obj.get("username", ""),
            "enc": obj.get("enc"),
            "saved_at": obj.get("saved_at"),
        }
        if args.reveal:
            try:
                out["password"] = _unprotect(obj.get("enc", "plain"), obj.get("secret", ""))
            except Exception as exc:
                out["password"] = ""
                out["error"] = f"解密失败：{exc}"
        if args.json:
            print(json.dumps(out, ensure_ascii=False))
        else:
            print(f"账号：{out['username']}")
            print(f"加密方式：{out['enc']}    保存时间：{out['saved_at']}")
            if args.reveal:
                print(f"密码：{out.get('password') or '（解密失败）'}")
                print("注意：不要在任何回复、日志或文件中转述该密码。")
        return 0

    # set
    password = args.password
    if password is None and not sys.stdin.isatty():
        password = sys.stdin.readline().rstrip("\r\n")
    if not password:
        print("缺少密码：请用 --password 传入，或通过标准输入提供。", file=sys.stderr)
        return 2
    enc, blob = _protect(password)
    obj = {
        "version": 1,
        "username": args.username,
        "enc": enc,
        "secret": base64.b64encode(blob).decode("ascii"),
        "saved_at": now_iso(),
    }
    save_json(CRED_FILE, obj)
    _restrict_permissions(CRED_FILE)
    if enc == "plain":
        print(f"已保存账号 {args.username}（当前系统不支持系统级加密，密码以混淆形式存放于用户目录，请勿分享该文件）。")
    else:
        print(f"已保存账号 {args.username}（加密方式：{enc}）。")
    return 0


# --------------------------------------------------------------------------- #
# 任务库
# --------------------------------------------------------------------------- #
def reconcile(tasks: list[dict]) -> None:
    """读取时修正状态与进度的一致性，避免历史数据自相矛盾。"""
    for t in tasks:
        p = to_progress(t.get("progress", 0))
        if t.get("status") == "done":
            t["progress"] = 100
            t.setdefault("completed_at", now_iso())
        elif p >= 100:
            t["status"] = "done"
            t["progress"] = 100
            t["completed_at"] = t.get("completed_at") or now_iso()
        elif p > 0 and t.get("status") == "todo":
            t["status"] = "doing"
            t["progress"] = p


def load_db() -> dict:
    db = load_json(TASKS_FILE, {"version": SCHEMA_VERSION, "updated_at": None, "tasks": []})
    if isinstance(db, list):  # 容错：直接给数组
        db = {"version": SCHEMA_VERSION, "updated_at": None, "tasks": db}
    db.setdefault("tasks", [])
    reconcile(db["tasks"])
    return db


def save_db(db: dict) -> None:
    db["version"] = SCHEMA_VERSION
    db["updated_at"] = now_iso()
    save_json(TASKS_FILE, db)


def normalize_task(raw: dict, existing: dict | None = None) -> dict:
    title = str(raw.get("title") or raw.get("name") or "").strip()
    if not title:
        raise ValueError("任务缺少 title")
    class_name = str(raw.get("class_name") or raw.get("class") or "").strip()
    tid = str(raw.get("id") or "").strip() or task_id(title, class_name)
    base = dict(existing or {})
    kind = normalize_kind(raw.get("kind") or raw.get("type") or base.get("kind"))
    status = str(raw.get("status") or base.get("status") or "todo").strip().lower()
    if status in ("done", "已完成", "完成"):
        status = "done"
    elif status in ("doing", "进行中", "学习中"):
        status = "doing"
    else:
        status = "todo"
    progress = to_progress(raw.get("progress", base.get("progress", 0)))
    if status == "done":
        progress = 100
    elif progress >= 100:
        status = "done"
    elif progress > 0 and status == "todo":
        status = "doing"  # 有进度就不是「未开始」
    task = {
        "id": tid,
        "title": title,
        "kind": kind,
        # 学时归属：网络自学 / 集中培训，两组独立考核
        "credit_group": normalize_credit_group(
            raw.get("credit_group") or raw.get("creditGroup") or base.get("credit_group"), kind),
        "required": bool(raw.get("required", base.get("required", False))),
        # 线下集中培训的固定日程（班级起止），网课为空
        "start": (parse_date(raw.get("start")) or parse_date(base.get("start"))).isoformat()
        if (parse_date(raw.get("start")) or parse_date(base.get("start"))) else None,
        "place": str(raw.get("place") or base.get("place") or ""),
        "deadline": (parse_date(raw.get("deadline")) or parse_date(base.get("deadline"))).isoformat()
        if (parse_date(raw.get("deadline")) or parse_date(base.get("deadline"))) else None,
        "hours": to_float(raw.get("hours", base.get("hours", 0))),
        "progress": progress,
        "status": status,
        "class_name": class_name or base.get("class_name", ""),
        "url": str(raw.get("url") or base.get("url") or ""),
        "platform_status": str(raw.get("platform_status") or base.get("platform_status") or ""),
        "notes": str(raw.get("notes") or base.get("notes") or ""),
        "first_seen": base.get("first_seen") or now_iso(),
        "last_seen": now_iso(),
        "completed_at": base.get("completed_at"),
    }
    if task["status"] == "done" and not task["completed_at"]:
        task["completed_at"] = now_iso()
    if task["status"] != "done":
        task["completed_at"] = None
    return task


def cmd_task(args: argparse.Namespace) -> int:
    db = load_db()
    tasks = db["tasks"]
    index = {t["id"]: i for i, t in enumerate(tasks)}

    if args.action == "import":
        src = Path(args.file)
        payload = load_json(src, None)
        if payload is None:
            print(f"文件不存在：{src}", file=sys.stderr)
            return 2
        rows = payload.get("tasks") if isinstance(payload, dict) else payload
        if not isinstance(rows, list):
            print("导入文件格式错误：应为任务数组或其 {tasks: [...]} 包装。", file=sys.stderr)
            return 2
        added = updated = skipped = 0
        for raw in rows:
            if not isinstance(raw, dict):
                skipped += 1
                continue
            try:
                existing = tasks[index[task_id(str(raw.get("title", "")), str(raw.get("class_name") or raw.get("class") or ""))]] \
                    if task_id(str(raw.get("title", "")), str(raw.get("class_name") or raw.get("class") or "")) in index else None
                task = normalize_task(raw, existing)
            except ValueError:
                skipped += 1
                continue
            if task["id"] in index:
                tasks[index[task["id"]]] = task
                updated += 1
            else:
                index[task["id"]] = len(tasks)
                tasks.append(task)
                added += 1
        save_db(db)
        print(f"导入完成：新增 {added}，更新 {updated}，跳过 {skipped}。任务库共 {len(tasks)} 条。")
        return 0

    if args.action == "add":
        task = normalize_task({
            "title": args.title, "kind": args.kind, "deadline": args.deadline,
            "hours": args.hours, "required": args.required, "class_name": args.class_name,
            "url": args.url, "progress": args.progress, "notes": args.notes,
        })
        if task["id"] in index:
            tasks[index[task["id"]]] = task
            print(f"已更新任务 {task['id']}：{task['title']}")
        else:
            tasks.append(task)
            print(f"已新增任务 {task['id']}：{task['title']}")
        save_db(db)
        return 0

    if args.action == "list":
        rows = tasks
        if args.status:
            rows = [t for t in rows if t["status"] == args.status]
        if args.pending:
            rows = [t for t in rows if t["status"] != "done"]
        rows = sorted(rows, key=lambda t: (t.get("deadline") or "9999-12-31", t["title"]))
        if args.json:
            print(json.dumps(rows, ensure_ascii=False, indent=2))
            return 0
        if not rows:
            print("任务库为空。先运行采集流程，或使用 task add 手工添加。")
            return 0
        print(f"{'ID':<12}{'类型':<8}{'截止':<12}{'进度':<7}{'学时':<6}{'必':<3}标题")
        for t in rows:
            mark = "是" if t["required"] else "-"
            print(f"{t['id']:<12}{KIND_LABEL.get(t['kind'], t['kind']):<8}"
                  f"{t.get('deadline') or '—':<12}{str(t['progress']) + '%':<7}"
                  f"{t['hours'] or 0:<6}{mark:<3}{t['title']}")
        print(f"\n共 {len(rows)} 条。")
        return 0

    if args.action in ("done", "undo", "rm"):
        if args.id not in index:
            print(f"未找到任务 {args.id}", file=sys.stderr)
            return 1
        i = index[args.id]
        if args.action == "rm":
            removed = tasks.pop(i)
            save_db(db)
            print(f"已删除：{removed['title']}")
            return 0
        if args.action == "done":
            tasks[i]["status"] = "done"
            tasks[i]["progress"] = 100
            tasks[i]["completed_at"] = now_iso()
        else:
            tasks[i]["status"] = "doing"
            tasks[i]["progress"] = min(tasks[i]["progress"], 99)
            tasks[i]["completed_at"] = None
        tasks[i]["last_seen"] = now_iso()
        save_db(db)
        print(f"已标记{'完成' if args.action == 'done' else '未完成'}：{tasks[i]['title']}")
        return 0

    if args.action == "stats":
        today = date.today()
        pending = [t for t in tasks if t["status"] != "done"]
        overdue = [t for t in pending if t.get("deadline") and parse_date(t["deadline"]) < today]
        due7 = [t for t in pending if t.get("deadline")
                and 0 <= (parse_date(t["deadline"]) - today).days <= 7]
        remain_hours = sum(remaining_hours(t) for t in pending)
        out = {
            "total": len(tasks),
            "done": len([t for t in tasks if t["status"] == "done"]),
            "pending": len(pending),
            "overdue": len(overdue),
            "due_within_7d": len(due7),
            "remaining_hours": round(remain_hours, 1),
            "by_kind": {},
        }
        for t in tasks:
            key = KIND_LABEL.get(t["kind"], t["kind"])
            out["by_kind"][key] = out["by_kind"].get(key, 0) + 1
        if args.json:
            print(json.dumps(out, ensure_ascii=False, indent=2))
        else:
            print(f"任务总数 {out['total']}，已完成 {out['done']}，待完成 {out['pending']}")
            print(f"已逾期 {out['overdue']}，7 天内到期 {out['due_within_7d']}，剩余约 {out['remaining_hours']} 学时")
            dist = "，".join(f"{k} {v}" for k, v in out["by_kind"].items())
            print(f"类型分布：{dist}")
        return 0

    return 2


# --------------------------------------------------------------------------- #
# 优先级与排期
# --------------------------------------------------------------------------- #
def remaining_hours(task: dict) -> float:
    """剩余学时。未标注学时的任务按 0.3 学时估算，避免排期把它们当零成本。"""
    hours = float(task.get("hours") or 0)
    ratio = max(0.0, 1 - int(task.get("progress") or 0) / 100.0)
    if hours <= 0:
        return round(0.3 * ratio, 2) if ratio > 0 else 0.0
    return round(hours * ratio, 2)


def urgency(task: dict, today: date,
            strategy: str = DEFAULT_PRIORITY) -> tuple[float, str]:
    """返回 (分数, 原因)。分数越高越该先做。

    优先级策略：
      layered（默认）  必修大幅加权（+800），常态下必修优先；
                       但「今天/明天截止」的选修可 +350 插队抢救。
      required-first   必修严格优先（+10000），组内再按临期排。
      deadline-first   按截止日优先，必修仅 +180 打破平局。

    临期基础分跨度 120–980，必修若只加 180 会被 3 天内截止的选修碾压，
    所以 layered 用 800 让必修在常态下压过非紧急选修。
    """
    if task.get("status") == "done":
        return -1.0, "已完成"
    dl = parse_date(task.get("deadline"))
    d = (dl - today).days if dl else None
    reasons: list[str] = []
    if dl is None:
        score = 120.0
        reasons.append("无截止日期")
    else:
        # 逾期已是既成事实，紧迫度低于"今天/明天截止"，避免挤占尚可挽救的任务
        if d < 0:
            score = 880.0 + min(-d, 10) * 3
            reasons.append(f"已逾期 {-d} 天")
        elif d == 0:
            score = 980.0
            reasons.append("今天截止")
        elif d == 1:
            score = 920.0
            reasons.append("明天截止")
        elif d <= 3:
            score = 800.0
            reasons.append(f"{d} 天内截止")
        elif d <= 5:
            score = 650.0
            reasons.append(f"{d} 天内截止")
        elif d <= 7:
            score = 560.0
            reasons.append(f"{d} 天内截止")
        elif d <= 10:
            score = 430.0
            reasons.append(f"{d} 天内截止")
        elif d <= 20:
            score = 270.0
            reasons.append(f"{d} 天内截止")
        else:
            score = 150.0
            reasons.append(f"{d} 天后截止")
        if d >= 0:
            density = min((float(task.get("hours") or 0) / max(d, 1)) * 40, 120)
            score += density

    required = bool(task.get("required"))
    if strategy == "required-first":
        score += 10000 if required else 0
        if required:
            reasons.append("必修（绝对优先）")
    elif strategy == "deadline-first":
        score += 180 if required else 0
        if required:
            reasons.append("必修")
    else:  # layered
        score += 800 if required else 0
        if required:
            reasons.append("必修（分层加权）")
        if d is not None and 0 <= d <= 1 and not required:
            score += 350
            reasons.append("极度临期，插队抢救")

    score += KIND_BONUS.get(task.get("kind", "other"), 0)
    ratio = 1 - int(task.get("progress") or 0) / 100.0
    score += 60 * ratio
    if task.get("kind") == "live":
        reasons.append("直播时段固定")
    if int(task.get("progress") or 0) > 0:
        reasons.append(f"已学 {task['progress']}%")
    return round(score, 1), "、".join(reasons) or "常规"


def build_plan(tasks: list[dict], days: int, daily_hours: float = 2.0,
               start: date | None = None, profile: dict | None = None,
               priority: str = DEFAULT_PRIORITY) -> dict:
    today = start or date.today()
    # 不传 profile 时退化为「每天固定 daily_hours」，保持旧调用兼容
    prof = profile or {
        "work_profile": "flat", "label": "统一每日学时",
        "weekday_hours": daily_hours, "weekend_hours": daily_hours,
        "priority": priority, "note": "",
    }
    buckets: dict[str, list[dict]] = {
        (today + timedelta(days=i)).isoformat(): [] for i in range(days)
    }
    # 在职员工工作日上班时间不可学习：按工作日 / 周末分别取容量
    daily_cap = {key: day_capacity(prof, date.fromisoformat(key)) for key in buckets}
    capacity = {k: 0.0 for k in buckets}

    pending = [t for t in tasks if t.get("status") != "done"]
    # 集中培训（线下班级）是固定日程：不能拆成"每晚 1 学时"，也不占每日自学容量
    fixed_raw = [t for t in pending if t.get("credit_group") == "集中培训"]
    pending = [t for t in pending if t.get("credit_group") != "集中培训"]
    scored = []
    for t in pending:
        s, why = urgency(t, today, priority)
        scored.append({**t, "score": s, "reason": why, "remain": remaining_hours(t)})
    scored.sort(key=lambda t: (-t["score"], t["remain"]))
    overflow: list[dict] = []
    day_keys = list(buckets.keys())

    for item in scored:
        remain = item["remain"]
        if remain <= 0:
            continue
        # 硬约束：未到期的任务不得排到自己截止日之后；已逾期的任务不再受截止日约束，尽快补完即可
        dl = parse_date(item.get("deadline"))
        if dl is None:
            last_idx = days - 1
        else:
            d = (dl - today).days
            last_idx = days - 1 if d < 0 else max(0, min(d, days - 1))

        for i in range(last_idx + 1):
            key = day_keys[i]
            free = daily_cap[key] - capacity[key]
            if free <= 1e-9:
                continue
            alloc = round(min(remain, free), 2)
            existing = next((x for x in buckets[key] if x["id"] == item["id"]), None)
            if existing:
                existing["alloc"] = round(existing["alloc"] + alloc, 2)
            else:
                buckets[key].append({
                    "id": item["id"], "title": item["title"],
                    "kind": item["kind"], "kind_label": KIND_LABEL.get(item["kind"], item["kind"]),
                    "alloc": alloc, "deadline": item.get("deadline"),
                    "required": item.get("required", False), "reason": item["reason"],
                    "url": item.get("url", ""),
                })
            capacity[key] = round(capacity[key] + alloc, 2)
            remain = round(remain - alloc, 2)
            if remain <= 1e-9:
                break
        if remain > 1e-9:
            late = dl is not None and last_idx < days - 1
            overflow.append({
                "id": item["id"], "title": item["title"],
                "unplaced_hours": remain, "deadline": item.get("deadline"),
                "reason": item["reason"],
                "cause": "截止日前容量不足" if late else "超出计划窗口",
            })

    total_remain = round(sum(t["remain"] for t in scored), 2)

    # 集中培训：按班级真实起止与学时列出固定日程，只提示不分配时段
    fixed: list[dict] = []
    for t in fixed_raw:
        end = parse_date(t.get("deadline"))
        start = parse_date(t.get("start")) or end
        fixed.append({
            "id": t["id"], "title": t["title"],
            "credit_group": "集中培训",
            "hours": round(to_float(t.get("hours", 0)), 2),
            "remaining_hours": remaining_hours(t),
            "progress": t.get("progress", 0),
            "start": start.isoformat() if start else None,
            "end": end.isoformat() if end else None,
            "place": t.get("place", ""),
            "days_left": (end - today).days if end else None,
            "in_window": bool(start and end and start <= today <= end),
            "required": t.get("required", False),
            "url": t.get("url", ""),
        })
    fixed.sort(key=lambda f: (f["end"] is None, f["end"] or "", f["title"]))
    fixed_remaining = round(sum(f["remaining_hours"] for f in fixed), 2)
    fixed_urgent = [f for f in fixed if f["days_left"] is not None and 0 <= f["days_left"] <= 7]

    overdue = [t for t in scored
               if t.get("deadline") and (parse_date(t["deadline"]) - today).days < 0]
    due7 = [t for t in scored
            if t.get("deadline") and 0 <= (parse_date(t["deadline"]) - today).days <= 7]
    window_capacity = round(sum(daily_cap.values()), 2)
    needed_daily = round(total_remain / days, 2) if days else 0.0

    warnings: list[str] = []
    if overdue:
        warnings.append(f"有 {len(overdue)} 项已逾期，需优先处理：" +
                        "、".join(t["title"] for t in overdue[:3]))
    if due7:
        warnings.append(f"有 {len(due7)} 项将在 7 天内到期。")
    if overflow:
        late = [o for o in overflow if o.get("cause") == "截止日前容量不足"]
        beyond = [o for o in overflow if o.get("cause") != "截止日前容量不足"]
        if late:
            warnings.append(
                "按当前每日投入无法在截止日前完成：" +
                "、".join(f"{o['title']}（还差 {o['unplaced_hours']} 学时）" for o in late) +
                f"。建议提高 --weekday-hours / --weekend-hours"
                f"（当前 {prof['weekday_hours']}/{prof['weekend_hours']} 学时），"
                f"或延长 --days；平均需约 {needed_daily} 学时/天。")
        if beyond:
            warnings.append(
                f"{len(beyond)} 项超出 {days} 天计划窗口（" +
                "、".join(o["title"] for o in beyond[:3]) +
                "），可延长 --days 或单列安排。")
    if total_remain > window_capacity and not overflow:
        warnings.append("总剩余学时接近窗口容量上限，几乎没有缓冲。")
    if fixed_urgent:
        warnings.append(
            "线下集中培训有固定日程，网课补不了，必须现场参训：" +
            "、".join(f"{f['title']}（{f['start'] or '—'}~{f['end']}，共 {f['hours']} 学时，"
                     f"剩余 {f['days_left']} 天）" for f in fixed_urgent) + "。")
    live_now = [f for f in fixed if f["in_window"]]
    if live_now:
        warnings.append(
            "正在进行中的班级：" + "、".join(f["title"] for f in live_now) +
            f"（地点：{live_now[0]['place'] or '见班级详情'}）。")

    return {
        "generated_at": now_iso(),
        "start": today.isoformat(),
        "days": days,
        "daily_hours": round(window_capacity / days, 2) if days else 0.0,
        "weekday_hours": prof["weekday_hours"],
        "weekend_hours": prof["weekend_hours"],
        "work_profile": prof.get("work_profile", "flat"),
        "profile_label": prof.get("label", "统一每日学时"),
        "priority_strategy": priority,
        "daily_capacity": daily_cap,
        "total_remaining_hours": total_remain,
        "fixed_remaining_hours": fixed_remaining,
        "window_capacity": window_capacity,
        "suggested_daily_hours": needed_daily,
        "counts": {"pending": len(scored) + len(fixed), "overdue": len(overdue),
                   "due_within_7d": len(due7), "fixed": len(fixed)},
        "fixed": fixed,
        "days_plan": [
            {"date": k, "hours": round(capacity[k], 2),
             "capacity": daily_cap[k], "items": buckets[k]}
            for k in day_keys
        ],
        "overflow": overflow,
        "warnings": warnings,
    }


def load_link_token() -> tuple[str, str | None]:
    """读取本地会话里的 access_token，供生成「免登录直达链接」用。

    返回 (token, expires_at)。没有会话、解密失败或已过期时 token 为空串。
    只读，不联网；token 由 `mooc_tasks.py` 登录后写入 data/session.dat。
    """
    session_file = DATA_DIR / "session.dat"
    if not session_file.exists():
        return "", None
    try:
        obj = json.loads(session_file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return "", None
    exp = obj.get("expires_at")
    if exp:
        try:
            if datetime.fromisoformat(exp) <= datetime.now():
                return "", exp
        except ValueError:
            pass
    try:
        token = _unprotect(obj.get("enc", "plain"), obj.get("token_b64", ""))
    except Exception:
        return "", exp
    return (token or ""), exp


def login_link(url: str, token: str) -> str:
    """把任务页路由包成「点开即登录」的链接。

    依据平台前端 main.js 的 OAuth 初始化逻辑（已抓源码确认，2026-11-04）：
    页面加载时读取 location.hash 中的 access_token / token_type / state，
    写入 localStorage.token，再 setlocationHash(decodeURIComponent(state)) 跳到目标路由，
    因此一次性链接的形态为：

        https://mooc.ctt.cn/#access_token=<token>&token_type=Bearer&state=<urlencoded 路由>

    state 必须整段 URL 编码：路由里可能含 `&`（如 /study/course/detail/4&<bid>），
    不编码会被前端按参数分隔符切断。编码后前端 decodeURIComponent 仍能还原完整路由。
    """
    if not url or not token:
        return url or ""
    route = url.split("#", 1)[1] if "#" in url else "/home"
    route = "/" + route.lstrip("/")
    return (f"{BASE_URL}/#access_token={token}&token_type=Bearer"
            f"&state={quote(route, safe='')}")


def render_plan_md(plan: dict, weekday: bool = True, token: str = "",
                   token_expires: str | None = None) -> str:
    names = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]
    priority_label = {
        "layered": "分层加权（必修优先，极度临期可插队）",
        "required-first": "必修绝对优先",
        "deadline-first": "临期绝对优先",
    }.get(plan.get("priority_strategy"), plan.get("priority_strategy", "—"))
    lines = [
        f"# 烟草网络学院学习计划（{plan['start']} 起 {plan['days']} 天）",
        "",
        f"- 待完成 {plan['counts']['pending']} 项：网络自学约 {plan['total_remaining_hours']} 学时"
        + (f"；线下集中培训 {plan['counts'].get('fixed', 0)} 项 "
           f"{plan.get('fixed_remaining_hours', 0)} 学时（固定日程，见下）"
           if plan.get("fixed") else ""),
        f"- 工作状态：{plan.get('profile_label', '统一每日学时')}；"
        f"工作日 {plan.get('weekday_hours', plan['daily_hours'])} 学时 / "
        f"周末 {plan.get('weekend_hours', plan['daily_hours'])} 学时"
        f"（工作日上班时间不排学习）",
        f"- 窗口容量 {plan['window_capacity']} 学时（按工作日 / 周末分别计）",
        f"- 优先级：{priority_label}",
        f"- 逾期 {plan['counts']['overdue']} 项，7 天内到期 {plan['counts']['due_within_7d']} 项",
        "",
    ]
    if token:
        exp = f"（有效期至 {token_expires}）" if token_expires else ""
        lines += [
            "> **本文件含登录凭据**：任务标题已做成直达链接，点开即自动登录，无需再扫码/输密码"
            f"{exp}。",
            "> 请勿转发、截图或提交到公开仓库；需要分享时用不带 `--login-links` 的版本重新生成。",
            "",
        ]
    if plan["warnings"]:
        lines.append("## 需要先看")
        lines.extend(f"- {w}" for w in plan["warnings"])
        lines.append("")

    if plan.get("fixed"):
        lines.append("## 线下集中培训（固定日程）")
        lines.append("")
        lines.append("| 培训 | 起止 | 学时 | 地点 | 状态 |")
        lines.append("| --- | --- | --- | --- | --- |")
        for f in plan["fixed"]:
            span = f"{f['start'] or '—'} ~ {f['end'] or '—'}"
            if f.get("days_left") is not None and f["days_left"] < 0:
                state = "已结束，未完成需补训"
            elif f.get("in_window"):
                state = f"进行中，还剩 {f['days_left']} 天" if f["days_left"] is not None else "进行中"
            else:
                state = f"距开始 {max(0, f['days_left'])} 天" if f["days_left"] is not None else "待定"
            title = f["title"]
            if token:
                link = login_link(f.get("url", ""), token)
                title = f"[{title}]({link})" if link else title
            lines.append(f"| {title} | {span} | {f['hours']} | {f['place'] or '—'} | {state} |")
        lines.append("")
        lines.append("> 这组学时计入**集中培训**，与网络自学分开考核，网课学时不能抵扣；"
                     "只能现场参训/签到，所以不参与下面的每日容量分配。")
        lines.append("")
    lines.append("## 每日安排（网络自学）")
    lines.append("")
    for day in plan["days_plan"]:
        d = date.fromisoformat(day["date"])
        label = f"{day['date']} {names[d.weekday()]}" if weekday else day["date"]
        cap = day.get("capacity", day["hours"])
        slot = "周末" if d.weekday() >= 5 else "工作日"
        if not day["items"]:
            lines.append(f"### {label} · {slot}（空档；当日可排 {cap} 学时）")
            continue
        lines.append(f"### {label} · {slot}（{day['hours']} / {cap} 学时）")
        lines.append("")
        lines.append("| 任务 | 类型 | 本次学时 | 截止 | 说明 |")
        lines.append("| --- | --- | --- | --- | --- |")
        for it in day["items"]:
            flag = "必修 · " if it["required"] else ""
            title = it["title"]
            if token:
                link = login_link(it.get("url", ""), token)
                # 有链接就整题可点；没有直达路由的（未验证类型）保持纯文本，避免死链
                title = f"[{title}]({link})" if link else f"{title}（无直达链接）"
            lines.append(
                f"| {title} | {flag}{it['kind_label']} | {it['alloc']} | "
                f"{it['deadline'] or '—'} | {it['reason']} |"
            )
        lines.append("")
    if plan["overflow"]:
        lines.append("## 未排入的任务")
        lines.append("")
        for it in plan["overflow"]:
            title = it["title"]
            if token:
                link = login_link(it.get("url", ""), token)
                title = f"[{title}]({link})" if link else title
            lines.append(f"- {title}：尚有 {it['unplaced_hours']} 学时未排入"
                         f"（截止 {it['deadline'] or '—'}，原因：{it.get('cause', '容量不足')}）")
        lines.append("")
    return "\n".join(lines)


def render_plan_html(plan: dict, token: str = "", token_expires: str | None = None) -> str:
    """把计划渲染成可直接双击打开的 HTML（链接可点，无需渲染器）。"""
    import html as _html

    names = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]
    priority_label = {
        "layered": "分层加权（必修优先，极度临期可插队）",
        "required-first": "必修绝对优先",
        "deadline-first": "临期绝对优先",
    }.get(plan.get("priority_strategy"), plan.get("priority_strategy", "—"))
    esc = _html.escape

    def link(it: dict) -> str:
        title = esc(it["title"])
        if not token:
            return title
        url = login_link(it.get("url", ""), token)
        return f'<a href="{esc(url)}" target="_blank" rel="noopener">{title}</a>' if url else title

    out = [
        "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">",
        f"<title>学习计划 {esc(plan['start'])} 起 {plan['days']} 天</title>",
        """<style>
:root{--ink:#1f2328;--muted:#6b7280;--line:#e5e7eb;--bg:#f6f7f9;--card:#fff;--accent:#1f6feb;--warn:#b45309;--warnbg:#fff7ed}
*{box-sizing:border-box}
body{margin:0;padding:28px 20px 60px;background:var(--bg);color:var(--ink);
  font:15px/1.65 "Microsoft YaHei","PingFang SC","Hiragino Sans GB",system-ui,sans-serif}
.wrap{max-width:920px;margin:0 auto}
h1{font-size:22px;margin:0 0 14px}
h2{font-size:16px;margin:26px 0 10px;padding-bottom:6px;border-bottom:2px solid var(--line)}
.meta{display:flex;flex-wrap:wrap;gap:8px 18px;color:var(--muted);font-size:13px;margin-bottom:16px}
.warn{background:var(--warnbg);border:1px solid #fed7aa;border-left:4px solid #f59e0b;
  color:var(--warn);padding:10px 14px;border-radius:6px;font-size:13px;margin:0 0 18px}
.day{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:12px 0}
.day h3{margin:0 0 10px;font-size:15px;display:flex;justify-content:space-between;align-items:baseline}
.day h3 span{font-weight:400;color:var(--muted);font-size:12.5px}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:7px 8px;border-bottom:1px solid #f0f1f3;vertical-align:top}
th{color:var(--muted);font-weight:500;font-size:12.5px}
tr:last-child td{border-bottom:0}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
.tag{display:inline-block;font-size:11.5px;padding:1px 6px;border-radius:4px;background:#eef2ff;color:#4338ca;margin-right:4px}
.tag.req{background:#fef2f2;color:#b91c1c}
.empty{color:var(--muted);font-size:13px}
ul.plain{margin:6px 0 0 18px;padding:0}
ul.plain li{margin:4px 0}
footer{margin-top:26px;color:var(--muted);font-size:12px}
</style></head><body><div class="wrap">""",
        f"<h1>烟草网络学院学习计划（{esc(plan['start'])} 起 {plan['days']} 天）</h1>",
        '<div class="meta">',
        f"<span>待完成 {plan['counts']['pending']} 项 · 网络自学约 "
        f"{plan['total_remaining_hours']} 学时"
        + (f" · 集中培训 {plan['counts'].get('fixed', 0)} 项 "
           f"{plan.get('fixed_remaining_hours', 0)} 学时（固定日程）"
           if plan.get("fixed") else "") + "</span>",
        f"<span>{esc(plan.get('profile_label', '统一每日学时'))}：工作日 "
        f"{plan.get('weekday_hours', plan['daily_hours'])} / 周末 "
        f"{plan.get('weekend_hours', plan['daily_hours'])} 学时</span>",
        f"<span>窗口容量 {plan['window_capacity']} 学时</span>",
        f"<span>{esc(priority_label)}</span>",
        f"<span>逾期 {plan['counts']['overdue']} · 7 天内到期 {plan['counts']['due_within_7d']}</span>",
        "</div>",
    ]
    if token:
        exp = f"（有效期至 {esc(token_expires)}）" if token_expires else ""
        out.append('<div class="warn"><b>本文件含登录凭据</b>：任务标题可直接点击，点开自动登录并进入'
                   f'对应课程/班级{exp}。请勿转发、截图或上传到公开仓库。</div>')
    for w in plan["warnings"]:
        out.append(f'<div class="warn">{esc(w)}</div>')

    if plan.get("fixed"):
        out.append(
            f'<div class="day"><h3>线下集中培训（固定日程）'
            f'<span>{len(plan["fixed"])} 个培训班 · {plan.get("fixed_remaining_hours", 0)} 学时待完成</span></h3>'
            "<table><thead><tr><th>培训</th><th>起止</th><th>学时</th><th>地点</th>"
            "<th>状态</th></tr></thead><tbody>")
        for f in plan["fixed"]:
            span = f"{esc(f['start'] or '—')} ~ {esc(f['end'] or '—')}"
            if f.get("days_left") is not None and f["days_left"] < 0:
                state = "已结束，未完成需补训"
            elif f.get("in_window"):
                state = (f"进行中，还剩 {f['days_left']} 天" if f["days_left"] is not None
                         else "进行中")
            else:
                state = (f"距开始 {max(0, f['days_left'])} 天" if f["days_left"] is not None
                         else "待定")
            tag = '<span class="tag req">必修</span>' if f.get("required") else ""
            out.append(f'<tr><td>{link(f)}</td><td>{span}</td>'
                       f'<td>{f["hours"]}</td><td>{esc(f["place"] or "—")}</td>'
                       f'<td>{tag}{esc(state)}</td></tr>')
        out.append("</tbody></table>"
                   '<div class="empty">这组学时计入<b>集中培训</b>，与网络自学分开考核、'
                   '不能互相抵扣；需现场参训，因此不参与下面的每日容量分配。</div></div>')

    out.append("<h2>每日安排</h2>")
    for day in plan["days_plan"]:
        d = date.fromisoformat(day["date"])
        label = f"{day['date']} {names[d.weekday()]}"
        cap = day.get("capacity", day["hours"])
        slot = "周末" if d.weekday() >= 5 else "工作日"
        out.append('<div class="day">')
        if day["items"]:
            out.append(f"<h3>{label} · {slot}<span>{day['hours']} / {cap} 学时</span></h3>")
            out.append("<table><thead><tr><th>任务</th><th>类型</th><th>本次</th>"
                       "<th>截止</th><th>说明</th></tr></thead><tbody>")
            for it in day["items"]:
                tag = '<span class="tag req">必修</span>' if it["required"] else ""
                out.append(
                    f"<tr><td>{link(it)}</td><td>{tag}{esc(it['kind_label'])}</td>"
                    f"<td>{it['alloc']}</td><td>{esc(it['deadline'] or '—')}</td>"
                    f"<td>{esc(it['reason'])}</td></tr>")
            out.append("</tbody></table>")
        else:
            out.append(f'<h3>{label} · {slot}<span>空档，当日可排 {cap} 学时</span></h3>'
                       '<div class="empty">这天不排学习，留给休息或补进度。</div>')
        out.append("</div>")

    if plan["overflow"]:
        out.append("<h2>未排入的任务</h2><ul class=\"plain\">")
        for it in plan["overflow"]:
            out.append(f"<li>{link(it)}：尚有 {it['unplaced_hours']} 学时未排入"
                       f"（截止 {esc(it['deadline'] or '—')}，原因：{esc(it.get('cause', '容量不足'))}）</li>")
        out.append("</ul>")
    out.append("<footer>由 tobacco-mooc-study skill 生成；仅做排期与提醒，不自动播放课程、不刷课、不代考。</footer>")
    out.append("</div></body></html>")
    return "\n".join(out)


def cmd_profile(args: argparse.Namespace) -> int:
    if args.action == "reset":
        PROFILE_FILE.unlink(missing_ok=True)
        print("已恢复默认档位：office（在职坐班，工作日 1 / 周末 3 学时）、分层加权。")
        return 0

    if args.action == "set":
        prof = save_profile(
            work_profile=args.work_profile, weekday_hours=args.weekday_hours,
            weekend_hours=args.weekend_hours, priority=args.priority, note=args.note)
        print(f"已保存工作状态：{prof['label']}"
              f"（工作日 {prof['weekday_hours']} / 周末 {prof['weekend_hours']} 学时，"
              f"优先级 {prof['priority']}）")
        if args.json:
            print(json.dumps(prof, ensure_ascii=False, indent=2))
        return 0

    prof = load_profile()
    if args.json:
        print(json.dumps(prof, ensure_ascii=False, indent=2))
    else:
        print(f"工作状态：{prof['label']}（{prof['work_profile']}）")
        print(f"  工作日 {prof['weekday_hours']} 学时 / 周末 {prof['weekend_hours']} 学时")
        print(f"  优先级策略：{prof['priority']}")
        print(f"  说明：{prof['note']}")
        print(f"  最近更新：{prof.get('updated_at') or '未保存（使用内置默认值）'}")
    return 0


def cmd_plan(args: argparse.Namespace) -> int:
    db = load_db()
    if not db["tasks"]:
        print("任务库为空，无法排期。先采集或导入学习任务。", file=sys.stderr)
        return 1
    start = parse_date(args.start) or date.today()
    prof = load_profile()
    if getattr(args, "work_profile", None):
        spec = WORK_PROFILES[args.work_profile]
        prof = {**prof, "work_profile": args.work_profile, "label": spec["label"],
                "weekday_hours": spec["weekday_hours"],
                "weekend_hours": spec["weekend_hours"], "note": spec["note"]}
    if getattr(args, "weekday_hours", None) is not None:
        prof["weekday_hours"] = args.weekday_hours
    if getattr(args, "weekend_hours", None) is not None:
        prof["weekend_hours"] = args.weekend_hours
    if getattr(args, "daily_hours", None) is not None:
        # 显式 --daily-hours 视为统一档，兼容旧用法
        prof = {**prof, "work_profile": "flat", "label": "统一每日学时",
                "weekday_hours": args.daily_hours, "weekend_hours": args.daily_hours}
    priority = getattr(args, "priority", None) or prof.get("priority", DEFAULT_PRIORITY)
    plan = build_plan(db["tasks"], days=args.days, start=start,
                      profile=prof, priority=priority)

    token, token_exp = "", None
    if getattr(args, "login_links", False):
        token, token_exp = load_link_token()
        if token:
            # 同一任务会跨多天出现，逐条写上直达链接，点哪天都能直接进
            for day in plan["days_plan"]:
                for it in day["items"]:
                    it["login_url"] = login_link(it.get("url", ""), token)
            for it in plan["overflow"]:
                it["login_url"] = login_link(it.get("url", ""), token)
        else:
            msg = ("未找到可用会话，链接不会带凭据。先登录（mooc_tasks.py login-password "
                   "或扫码）再重新生成。" if not token_exp
                   else f"本地会话已于 {token_exp} 过期，链接不会带凭据，请重新登录后再生成。")
            plan["warnings"].append(msg)

    if args.json:
        print(json.dumps(plan, ensure_ascii=False, indent=2))
    else:
        out_path = Path(args.out) if args.out else None
        as_html = bool(getattr(args, "html", False)) or bool(
            out_path and out_path.suffix.lower() in (".html", ".htm"))
        text = (render_plan_html(plan, token=token, token_expires=token_exp) if as_html
                else render_plan_md(plan, token=token, token_expires=token_exp))
        if out_path:
            out_path.parent.mkdir(parents=True, exist_ok=True)
            out_path.write_text(text, encoding="utf-8")
            if token:
                _restrict_permissions(out_path)     # 文件含凭据，收窄到仅当前用户可读
            print(f"学习计划已写入 {out_path}")
            if token:
                print(f"已生成免登录直达链接（token 有效期至 {token_exp}）。"
                      "该文件含凭据，请勿外发。")
            print("\n".join(plan["warnings"]) or "无风险提示。")
        else:
            print(text)
    if args.out and args.json:
        Path(args.out).write_text(json.dumps(plan, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0


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


def render_ics(tasks: list[dict], today: date | None = None,
               required_only: bool = False, alarm_days: int = 3,
               mask_titles: bool = False) -> str:
    """把任务截止日导出成 iCalendar：截止日全天事件 + 提前 N 天提醒。

    平台不提供日历订阅，学员只能自己记截止日。文件放进任何静态地址（GitHub Pages、
    内网静态站）后，手机日历用「添加日历订阅」填该 https 地址即可定期自动刷新。

    注意：文件里只有任务标题/学时/普通课程链接，**不要**把带 access_token 的
    直达链接写进这里——订阅地址通常是公开的。订阅仓库公开时用 mask_titles=True，
    把课程名替换成「必修任务 #n」，避免学习内容外泄。
    """
    now = today or date.today()
    stamp = now.strftime("%Y%m%d") + "T000000Z"
    n = 0
    lines = ["BEGIN:VCALENDAR", "VERSION:2.0",
             "PRODID:-//tobacco-mooc-study//学习任务//CN", "CALSCALE:GREGORIAN"]
    for t in tasks:
        dl = parse_date(t.get("deadline"))
        if not dl:
            continue                                  # 没有截止日的事件没有意义
        if required_only and not t.get("required"):
            continue                                  # 日历订阅只要必修
        if t.get("status") == "done":
            continue                                  # 已完成的不该继续提醒
        n += 1
        label = KIND_LABEL.get(t.get("kind"), t.get("kind") or "")
        req = "必修" if t.get("required") else "选修"
        left = (dl - now).days
        when = f"还差 {left} 天" if left >= 0 else f"已逾期 {-left} 天"
        title = f"必修任务 #{n}" if mask_titles else (t.get("title") or "")
        summary = f"【截止】{req} · {title}（{when}）"
        desc = [f"学时 {t.get('hours') or 0}", f"截止 {dl.isoformat()}",
                f"状态 {t.get('status') or ''}"]
        if not mask_titles:                       # 脱敏模式下班级名/备注同样会暴露身份
            if t.get("class_name"):
                desc.append(f"班级 {t['class_name']}")
            if t.get("notes"):
                desc.append(str(t["notes"]))
        lines += ["BEGIN:VEVENT",
                  f"UID:{t.get('id')}@tobacco-mooc-study",
                  f"DTSTAMP:{stamp}",
                  f"DTSTART;VALUE=DATE:{dl.strftime('%Y%m%d')}",
                  _ics_fold(f"SUMMARY:{_ics_escape(summary)}"),
                  _ics_fold(f"DESCRIPTION:{_ics_escape('; '.join(desc))}")]
        if t.get("url"):
            lines.append(_ics_fold(f"URL:{t['url']}"))
        if alarm_days > 0:
            lines += ["BEGIN:VALARM", f"TRIGGER:-P{int(alarm_days)}D", "ACTION:DISPLAY",
                      _ics_fold(f"DESCRIPTION:{_ics_escape(summary)}"), "END:VALARM"]
        lines.append("END:VEVENT")
    lines.append("END:VCALENDAR")
    return "\r\n".join(lines) + "\r\n"


def cmd_report(args: argparse.Namespace) -> int:
    db = load_db()
    today = date.today()
    rows = []
    for t in db["tasks"]:
        dl = parse_date(t.get("deadline"))
        rows.append({
            "ID": t["id"], "标题": t["title"],
            "类型": KIND_LABEL.get(t["kind"], t["kind"]),
            "必修": "是" if t.get("required") else "否",
            "班级": t.get("class_name", ""),
            "截止日期": dl.isoformat() if dl else "",
            "剩余天数": (dl - today).days if dl else "",
            "学时": t.get("hours", 0), "进度%": t.get("progress", 0),
            "状态": {"todo": "未开始", "doing": "进行中", "done": "已完成"}.get(t["status"], t["status"]),
            "平台状态": t.get("platform_status", ""), "链接": t.get("url", ""),
            "备注": t.get("notes", ""),
        })
    rows.sort(key=lambda r: (r["状态"] == "已完成", r["截止日期"] or "9999-12-31"))
    out = Path(args.out) if args.out else DATA_DIR / f"tasks-{today.isoformat()}.{args.format}"
    out.parent.mkdir(parents=True, exist_ok=True)
    if args.format == "ics":
        out.write_text(render_ics(db["tasks"], today,
                                  required_only=args.required_only,
                                  alarm_days=args.alarm_days,
                                  mask_titles=args.mask_titles), encoding="utf-8")
        n = sum(1 for t in db["tasks"]
                if parse_date(t.get("deadline")) and (t.get("required") or not args.required_only))
        scope = "必修" if args.required_only else "全部"
        alarm = f"提前 {args.alarm_days} 天提醒" if args.alarm_days > 0 else "不提醒"
        print(f"已导出 {n} 个{scope}任务的截止日到 {out}（{alarm}）")
        print("订阅做法：把该文件放到能公网/内网访问的静态地址（GitHub Pages、内网静态站等），"
              "手机日历里「添加日历订阅」填该地址即可定期自动刷新；"
              "文件只含标题/学时/普通课程链接，切勿把带 access_token 的直达链接写进公开位置。")
        return 0
    if args.format == "csv":
        with out.open("w", encoding="utf-8-sig", newline="") as fh:
            writer = csv.DictWriter(fh, fieldnames=list(rows[0].keys()) if rows else ["ID"])
            writer.writeheader()
            writer.writerows(rows)
    else:
        lines = [f"# 学习任务清单（导出 {today.isoformat()}）", ""]
        if rows:
            lines.append("| " + " | ".join(rows[0].keys()) + " |")
            lines.append("| " + " | ".join("---" for _ in rows[0]) + " |")
            for r in rows:
                lines.append("| " + " | ".join(str(v) for v in r.values()) + " |")
        else:
            lines.append("（无任务）")
        out.write_text("\n".join(lines), encoding="utf-8")
    print(f"已导出 {len(rows)} 条任务到 {out}")
    return 0


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #
def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="tobacco.py",
        description="烟草网络学院学习任务本地管理：凭据保存、任务库、优先级排期、导出。",
    )
    sub = p.add_subparsers(dest="group", required=True)

    c = sub.add_parser("cred", help="账号凭据的保存、读取与清除")
    c.add_argument("action", choices=["set", "get", "clear"])
    c.add_argument("--username")
    c.add_argument("--password", help="不传则从标准输入读取，避免写入命令历史")
    c.add_argument("--reveal", action="store_true", help="输出明文密码（仅在填表时使用）")
    c.add_argument("--json", action="store_true")
    c.set_defaults(func=cmd_cred)

    t = sub.add_parser("task", help="任务库操作")
    t.add_argument("action", choices=["import", "add", "list", "done", "undo", "rm", "stats"])
    t.add_argument("--file", help="import 时的 JSON 文件路径")
    t.add_argument("--id", help="done/undo/rm 的任务 ID")
    t.add_argument("--title")
    t.add_argument("--kind", default="course",
                   help="course/live/exam/survey/class_task/other，也接受中文")
    t.add_argument("--deadline")
    t.add_argument("--hours", type=float, default=0)
    t.add_argument("--progress", default=0)
    t.add_argument("--required", action="store_true")
    t.add_argument("--class-name", dest="class_name", default="")
    t.add_argument("--url", default="")
    t.add_argument("--notes", default="")
    t.add_argument("--status", choices=STATUSES, help="list 过滤")
    t.add_argument("--pending", action="store_true", help="list 只看未完成")
    t.add_argument("--json", action="store_true")
    t.set_defaults(func=cmd_task)

    pf = sub.add_parser("profile", help="设置在职工作状态（工作日/周末可学学时）与优先级策略")
    pf.add_argument("action", choices=["set", "get", "reset"])
    pf.add_argument("--work-profile", choices=list(WORK_PROFILES),
                    help="office 在职坐班 / overtime 加班出差 / leave 休假 / shift 轮班 / flat 统一")
    pf.add_argument("--weekday-hours", type=float, help="覆盖工作日每日学时")
    pf.add_argument("--weekend-hours", type=float, help="覆盖周末每日学时")
    pf.add_argument("--priority", choices=list(PRIORITY_STRATEGIES),
                    help="layered 分层加权 / required-first 必修绝对 / deadline-first 临期绝对")
    pf.add_argument("--note", help="自定义说明")
    pf.add_argument("--json", action="store_true")
    pf.set_defaults(func=cmd_profile)

    pl = sub.add_parser("plan", help="按工作状态与优先级生成每日学习计划")
    pl.add_argument("--days", type=int, default=14)
    pl.add_argument("--daily-hours", dest="daily_hours", type=float, default=None,
                    help="显式指定则视为统一每日学时（覆盖工作档位）")
    pl.add_argument("--work-profile", choices=list(WORK_PROFILES),
                    help="临时覆盖已保存的工作状态档位")
    pl.add_argument("--weekday-hours", type=float, help="临时覆盖工作日学时")
    pl.add_argument("--weekend-hours", type=float, help="临时覆盖周末学时")
    pl.add_argument("--priority", choices=list(PRIORITY_STRATEGIES),
                    help="临时覆盖已保存的优先级策略")
    pl.add_argument("--start", help="计划起始日，默认今天")
    pl.add_argument("--out", help="写入文件（.md 或配合 --json 写 JSON）")
    pl.add_argument("--login-links", action="store_true",
                    help="任务标题做成带 access_token 的直达链接（点开免登录；文件含凭据，勿分享）")
    pl.add_argument("--html", action="store_true",
                    help="输出 HTML（可直接双击打开、链接可点）；--out 以 .html 结尾时自动启用")
    pl.add_argument("--json", action="store_true")
    pl.set_defaults(func=cmd_plan)

    r = sub.add_parser("report", help="导出任务清单")
    r.add_argument("--format", choices=["md", "csv", "ics"], default="md",
                   help="ics = iCalendar 日历文件（可导入，也可托管后给手机日历订阅）")
    r.add_argument("--required-only", action="store_true",
                   help="ics 时只导出必修任务（日历订阅通常只关心必修）")
    r.add_argument("--alarm-days", type=int, default=3, metavar="N",
                   help="ics 时提前几天提醒，0 = 不提醒（默认 3）")
    r.add_argument("--mask-titles", action="store_true",
                   help="ics 时把课程名替换成「必修任务 #n」（订阅仓库公开时用）")
    r.add_argument("--out")
    r.set_defaults(func=cmd_report)
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
