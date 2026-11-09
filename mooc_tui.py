#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
烟草网络学院 —— 自动学习 TUI
=============================
基于 Textual 的交互界面, 复用 mooc_auto_study.StudyBot。

启动:
    python mooc_tui.py --mode audio          # 音频模式(默认 auto)
    python mooc_tui.py --mode audio --dry-run

快捷键:
    r  刷新列表与学时     /  搜索任务
    s  学习选中的课程/专题
    a  完成全部 未完成/未开始 (弹确认框)
    h  补"网络自学"学时 (回车确认, auto=补齐到要求线, esc 取消)
    d  切换 dry-run(只体检不上报)      u  切换账号
    n  添加账号                         q  退出

实现 (遵循 textual-tui-skill):
    run_worker(thread=True, group/exclusive) 后台任务 · call_from_thread 更新 UI
    ModalScreen 确认框 · notify 轻提示 · 内置主题 tokyo-night · Pilot 无头测试
"""

import argparse
import threading
import unicodedata
import time as _time

from rich.text import Text
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical
from textual.screen import ModalScreen, Screen
from textual.widgets import Button, DataTable, Footer, Header, Input, RichLog, Static

import mooc_client
from mooc_api_login import add_account as env_add_account
from mooc_auto_study import QuotaExhausted, StudyBot, resolve_user

TYPE_NAME = {1: "课程", 2: "专题", 3: "考试", 4: "调研", 5: "班级", 6: "直播"}

STATE_STYLE = {"未开始": "yellow", "学习中": "dodger_blue",
               "已完成": "spring_green", "已过期": "grey50"}

def disp_width(s: str) -> int:
    """终端显示宽度: CJK/全角按 2, 其余按 1。"""
    return sum(2 if unicodedata.east_asian_width(ch) in "WF" else 1
               for ch in s)


def fit_text(s: str, width: int) -> str:
    """按显示宽度截断字符串, 超出加省略号。"""
    out, used = "", 0
    for ch in s:
        cw = 2 if unicodedata.east_asian_width(ch) in "WF" else 1
        if used + cw > width - 1:
            return out + "…"
        out += ch
        used += cw
    return out


# 排序模式: (标签, key函数); 未开始/未完成优先于学习中, 必修优先于选修
_STATE_ORDER = {"未开始": 0, "学习中": 1, "已完成": 2, "已过期": 3}
_TYPE_ORDER = {"课程": 0, "专题": 1, "班级": 2, "考试": 3, "调研": 4, "直播": 5}
def _is_done(r):
    return r.get("state") in ("已完成", "已过期")


# 上次学习时间(lastAccessTime)已被剔除: 它是"上次访问时间", 本工具的任何
# API 调用都会改写它 —— 数据污染, 不可作为排序/展示依据。
# 排序仅使用干净要素: 要求 / 状态 / 推送时间 / 注册时间。
AUTO_WIDTH = True       # True=DataTable 自适应测宽(实验) / False=显式固定列宽
SORT_MODES = [
    ("默认: 继续学习 (未完成优先·推送时间倒序)", lambda r: (
        _is_done(r),
        -(r.get("push_ts") or r.get("reg_ts") or 0),
        r.get("required") != "必修",
        _STATE_ORDER.get(r.get("state"), 9),
        r.get("name") or "")),
    ("必修优先 (未完成在前·推送时间倒序)", lambda r: (
        r.get("required") != "必修",
        _is_done(r),
        _STATE_ORDER.get(r.get("state"), 9),
        -(r.get("push_ts") or r.get("reg_ts") or 0),
        r.get("name") or "")),
    ("状态优先 (未开始→学习中→已完成)", lambda r: (
        _STATE_ORDER.get(r.get("state"), 9),
        r.get("required") != "必修",
        -(r.get("push_ts") or 0),
        r.get("name") or "")),
    ("注册学习时间 新→旧", lambda r: -(r.get("reg_ts") or 0)),
    ("推送时间 新→旧", lambda r: -(r.get("push_ts") or 0)),
]


def _styled(text):
    """按内容给日志行着色。"""
    if "FAIL" in text or "异常" in text:
        return Text(text, style="red")
    if "-> OK" in text or "🎉" in text or "✅" in text:
        return Text(text, style="spring_green")
    if text.startswith(("#####", "=====")):
        return Text(text, style="bold yellow")
    if text.startswith(("[TUI]", "[学时]", "[凭证]", "[账号]", "[匹配]")):
        return Text(text, style="cyan")
    return Text(text)


def _say_via(app, log_id="#log"):
    """把 StudyBot 的输出桥接到 TUI 日志面板 (线程安全)。"""
    def say(*a, **k):
        text = " ".join(str(x) for x in a)
        app.call_from_thread(app.query_one(log_id, RichLog).write, _styled(text))
    return say


SEC_TYPE = {1: "pdf", 2: "图片", 3: "链接", 4: "scorm", 5: "音频", 6: "视频",
            7: "epub", 8: "作业", 9: "考试", 10: "关联课程", 12: "调研"}


class SectionScreen(Screen):
    """小节列表详情 (回车进入, Esc 返回)。"""

    CSS = """
    SectionScreen { layout: vertical; background: $surface-darken-1; }
    #sec-title { dock: top; height: auto; padding: 1 2;
                 background: $panel; border: round $primary; }
    #sec-table { height: 1fr; margin: 0 1 1 1; border: round $primary; }
    """

    BINDINGS = [Binding("escape", "back", "返回"),
                Binding("q", "back", "返回", show=False)]

    def __init__(self, row, bot_ref, depth=0, crumb="") -> None:
        super().__init__()
        self.row = row
        self.bot_ref = bot_ref
        self.depth = depth
        self._secs = []
        self.crumb = crumb or row["name"][:30]

    def compose(self) -> ComposeResult:
        extra = (f" {self.row['percent']}%" if self.row.get("percent") is not None else "")
        yield Static(f"[bold]{self.row['name'][:44]}[/]\n"
                     f"[dim]{self.crumb}[/]\n"
                     f"[dim]{self.row['type']} · {self.row['required']} · "
                     f"{self.row['state']}{extra}[/]", id="sec-title")
        t = DataTable(id="sec-table", cursor_type="row", zebra_stripes=True)
        t.border_title = "小节列表"
        yield t
        yield Footer()

    def on_resize(self, event) -> None:
        """终端尺寸变化 → 重算名称列宽并重绘 (数据已在内存, 无网络请求)。"""
        if not isinstance(self, StudyTUI):
            return          # 子屏幕(如小节详情)冒泡触发时 self 不是主界面
        if self._view_rows and not self.busy:
            self._refill()

    def on_mount(self) -> None:
        t = self.query_one("#sec-table", DataTable)
        name_label = "小节名称" if self.depth == 0 else "视频名称"
        for label, w in [("类型", 10), ("状态", 8), (name_label, 60)]:
            t.add_column(label, width=w, key=label)
        self.run_worker(self._load, thread=True, name="detail", group="detail",
                        exclusive=True)

    def _load(self):
        try:
            bot = self.bot_ref
            det = bot._req("POST", "api/v1/course-study/course-front/register",
                           data={"courseId": self.row["bid"]})[1] or {}
            secs = bot.sections(self.row["bid"], det.get("versionId", ""),
                                det.get("register", False))
            self._secs = secs
            self.app.call_from_thread(self._fill, secs)
        except Exception as e:
            self.app.call_from_thread(self._fill, None, str(e))

    def _fill(self, secs, err=None):
        t = self.query_one("#sec-table", DataTable)
        list_name = "小节列表" if self.depth == 0 else "视频列表"
        hint = ("回车进入关联课程的 视频列表" if self.depth == 0
                else "已是最底层 (视频列表)")
        if err or secs is None:
            t.border_title = f"无法获取{list_name}" + (f" ({err})" if err else "")
            return
        t.border_title = f"{list_name} ({len(secs)} 个) · {hint}"
        for s in secs:
            fin = s["finish"]
            state = {0: "未开始", 1: "学习中", 2: "已完成"}.get(fin, str(fin))
            style = {"未开始": "yellow", "学习中": "dodger_blue",
                     "已完成": "spring_green"}.get(state, "")
            t.add_row(Text(SEC_TYPE.get(s["type"], s["type"])),
                      Text(state, style),
                      (s["name"] or "")[:20],
                      key=s["section_id"])

    def on_data_table_row_selected(self, event) -> None:
        """点击/回车小节: 关联课程(sectionType=10) → 下钻显示其视频列表。"""
        if event.data_table.id != "sec-table" or self.depth >= 3:
            return
        key = event.row_key.value
        sec = next((x for x in self._secs or [] if x["section_id"] == key), None)
        if not sec:
            return
        if sec["type"] != 10:
            self.notify(f"「{SEC_TYPE.get(sec['type'], sec['type'])}」没有下级列表"
                        f" (已在{'视频列表' if self.depth else '小节列表'}底层)",
                        severity="warning", timeout=4)
            return
        child = {"bid": sec["resource_id"], "name": sec["name"] or "关联课程",
                 "type": "关联课程", "required": "—", "state": "学习中",
                 "percent": None}
        self.app.push_screen(SectionScreen(child, self.bot_ref,
                                           depth=self.depth + 1,
                                           crumb=f"{self.crumb} ▸ {sec['name'][:24]}"))

    def action_back(self) -> None:
        self.app.pop_screen()


class ConfirmScreen(ModalScreen[bool]):
    """模态确认框 (skill: ModalScreen + push_screen_wait)。"""

    CSS = """
    ConfirmScreen { align: center middle; background: $background 60%; }
    #dialog { width: 64; height: auto; padding: 1 2;
              background: $panel; border: thick $warning; }
    #dialog Static { width: 1fr; }
    #dialog Horizontal { height: auto; align-horizontal: center; margin-top: 1; }
    Button { margin: 0 1; min-width: 12; }
    """

    def __init__(self, message: str) -> None:
        super().__init__()
        self.message = message

    def compose(self) -> ComposeResult:
        with Vertical(id="dialog"):
            yield Static(self.message)
            with Horizontal():
                yield Button("开始", variant="primary", id="yes")
                yield Button("取消", variant="error", id="no")

    def on_button_pressed(self, event: Button.Pressed) -> None:
        self.dismiss(event.button.id == "yes")


class StudyTUI(App):
    TITLE = "烟草网络学院 · 自动学习"
    SUB_TITLE = "mooc_auto_study TUI"
    theme = "tokyo-night"

    CSS = """
    Screen { layout: vertical; background: $surface-darken-1; }
    #hours {
        dock: top; height: auto; padding: 1 2; margin: 0 0 1 0;
        background: $panel; border: round $primary; text-align: center;
    }
    #table {
        height: 52%; margin: 0 1 1 1; border: round $primary;
        background: $surface;
    }
    #log {
        border: round $secondary; border-title-align: left;
        padding: 0 1; background: $surface; scrollbar-gutter: stable;
    }
    Input { display: none; border: round yellow; }
    Input.visible { display: block; }
    """

    BINDINGS = [
        Binding("r", "refresh", "刷新列表"),
        Binding("slash", "filter", "搜索"),
        Binding("s", "study", "学习选中"),
        Binding("a", "study_all", "完成全部"),
        Binding("h", "hours", "补学时"),
        Binding("d", "dryrun", "切换dry-run"),
        Binding("u", "user", "切换账号"),
        Binding("o", "sort", "排序"),
        Binding("x", "toggle_done", "已完成显示/隐藏"),
        Binding("n", "add_account", "添加账号"),
        Binding("q", "quit", "退出"),
    ]

    def __init__(self, mode="auto", dry_run=False, user=None):
        super().__init__()
        self.mode = mode
        self.dry_run = dry_run
        self.user = user
        self.bot = None
        self.busy = False
        self.input_mode = "hours"
        self.add_step = 0
        self.filter_key = ""
        self.sort_mode = 0
        self.show_done = False          # 默认隐藏已完成任务
        self._view_rows = []
        self._shown_rows = []
        mooc_client.set_user(resolve_user(user))
        self.user = mooc_client.get_user()

    # ------------------------------------------------------------ UI 组装
    def compose(self) -> ComposeResult:
        yield Header(show_clock=True)
        yield Static("", id="hours")
        yield DataTable(id="table", cursor_type="row", zebra_stripes=True)
        yield RichLog(id="log", markup=False, wrap=True, highlight=False)
        yield Input(id="hours-input")
        yield Footer()

    def on_resize(self, event) -> None:
        """终端尺寸变化 → 重算名称列宽并重绘 (数据已在内存, 无网络请求)。"""
        if not isinstance(self, StudyTUI):
            return          # 子屏幕(如小节详情)冒泡触发时 self 不是主界面
        if self._view_rows and not self.busy:
            self._refill()

    def on_mount(self) -> None:
        table = self.query_one("#table", DataTable)
        # 显式列宽: DataTable 对 CJK 宽字符的自适应测宽不准, 会造成列重叠;
        # 总宽控制在 99 列内, 兼容 105 列的终端窗口 (超出会被压缩)
        for label, w in [("类型", 6), ("要求", 4), ("状态", 6),
                         ("名称", 40), ("推送时间", 12), ("id", 11), ("URL", 20)]:
            table.add_column(label, width=w, key=label)
        self._update_table_title()
        self.query_one("#log").border_title = "运行日志"
        self.log_write(f"[TUI] 模式 {self.mode} | dry-run {'开' if self.dry_run else '关'}")
        self.action_refresh()

    # ------------------------------------------------------------ 工具
    def log_write(self, text: str) -> None:
        self.query_one("#log", RichLog).write(_styled(text))

    @staticmethod
    def _hours_text(info, dry_run, mode, counts=None, user=""):
        hs, req = info.get("hourSelf", 0), info.get("requireCourseHour", 0)
        ok = "[green]" if hs >= req else "[red]"
        base = (f"[bold]网络自学[/] {ok}{hs}[/] / {req} 学时"
                f"   [dim]|[/] 集中培训 [cyan]{info.get('hourTrain', 0)}[/] 学时"
                f"   [dim]|[/] 账号 [magenta]{user}[/]")
        if counts:
            base += (f"\n未开始 [yellow]{counts.get('未开始', 0)}[/]"
                     f"  学习中 [dodger_blue]{counts.get('学习中', 0)}[/]"
                     f"  已完成 [spring_green]{counts.get('已完成', 0)}[/]"
                     f"  已过期 [grey50]{counts.get('已过期', 0)}[/]")
        tag = "[red]DRY-RUN[/] " if dry_run else ""
        base += f"\n[dim]{tag}{mode} 模式[/]"
        return base

    def _update_table_title(self) -> None:
        sort_label = SORT_MODES[self.sort_mode][0]
        base = f"任务列表 · 排序: {sort_label} (回车 进入小节列表 · o 排序 · / 搜索 · s 学习选中 · a 完成全部)"
        if self.filter_key:
            base += f" · 筛选: {self.filter_key!r} ({len(self._shown_rows)}/{len(self._view_rows)})"
        self.query_one("#table", DataTable).border_title = base

    def _refill(self) -> None:
        """按 filter_key 过滤 _view_rows 并重绘表格。"""
        table = self.query_one("#table", DataTable)
        table.clear()
        fk = self.filter_key
        shown = [r for r in self._view_rows
                 if (self.show_done or r["state"] != "已完成")
                 and (not fk or any(fk in str(r.get(k, "")).lower()
                                    for k in ("name", "type", "state", "required", "bid")))]
        self._shown_rows = shown
        from collections import Counter
        cnt = Counter(r["state"] for r in shown)
        info = self.bot.hours_self() if self.bot else {}
        self.query_one("#hours", Static).update(
            self._hours_text(info, self.dry_run, self.mode, cnt, self._display_user()))
        shown.sort(key=SORT_MODES[self.sort_mode][1])
        # 名称列宽自适应: 按当前可见行最长的名称计算, 上限受终端宽度约束
        others = 6 + 4 + 6 + 12 + 11 + 20      # 其余固定列宽合计
        avail = max(60, self.size.width - 10) - others
        name_w = min(60, max(24, min(avail,
                     max([disp_width(r.get("name") or "") for r in shown],
                         default=24) + 2)))
        table.columns["名称"].width = name_w
        name_cap = 60 if AUTO_WIDTH else 20
        idx_of = {id(r): i for i, r in enumerate(self._view_rows)}
        for r in shown:
            r["_rk"] = str(idx_of[id(r)])       # 行键 = 全量视图索引, 稳定
            req_style = ("bold red" if r["required"] == "必修"
                         else "green" if r["required"] == "选修" else "grey50")
            state_cell = Text(r["state"], STATE_STYLE.get(r["state"], ""))
            pts = (r.get("push_ts") or (r.get("reg_ts") or 0)) / 1000
            pts_text = _time.strftime("%m-%d %H:%M", _time.localtime(pts)) if pts else "—"
            table.add_row(
                Text(r["type"]),
                Text(r["required"], req_style),
                state_cell,
                fit_text(r.get("name") or "", name_w),
                pts_text,
                Text((r["bid"] or "")[:8] + "…", "grey50"),
                Text((r.get("url") or "")[:17], "grey50"),
                key=r["_rk"])
        self._update_table_title()

    def _display_user(self) -> str:
        """账号显示名: 优先平台真实姓名。"""
        import mooc_api_login as m
        tok = m._read_token(self.user) or {}
        return tok.get("display_name") or self.user

    def set_hours(self) -> None:
        try:
            info = self.bot.hours_self() if self.bot else {}
        except Exception as e:
            info = {}
            self.log_write(f"[学时] 读取失败 {e}")
        if info:
            self.query_one("#hours", Static).update(
                self._hours_text(info, self.dry_run, self.mode, user=self._display_user()))

    def _ensure_bot(self):
        if self.bot is None:
            self.bot = StudyBot(verbose=True, dry_run=self.dry_run,
                                ws=False, mode=self.mode, say=_say_via(self))
        return self.bot

    def _run_op(self, fn, label):
        """在后台线程跑一个 StudyBot 操作; 期间锁住快捷键。"""
        if self.busy:
            self.log_write(f"[TUI] 已有任务在跑, 请等它结束")
            return
        self.busy = True
        self.sub_title = f"运行中: {label}"

        def runner():
            try:
                bot = self._ensure_bot()
                bot.dry_run = self.dry_run
                fn(bot)
            except QuotaExhausted as e:
                self.call_from_thread(self._quota_stop, str(e))
            except Exception as e:
                self.call_from_thread(self.log_write, f"[TUI] 异常 {type(e).__name__}: {e}")
            finally:
                self.call_from_thread(self._op_done, label)

        self.run_worker(runner, thread=True, name="op", group="ops",
                        exclusive=True)

    def _quota_stop(self, msg: str) -> None:
        """配额熔断: 日志 + 通知, 停止一切后续处理。"""
        self.log_write(f"[配额] ⛔ {msg}")
        self.log_write("[配额] —— 已停止全部处理, 请次日重跑 ——")
        self.notify("当日学时配额已满, 已停止处理", severity="error", timeout=8)

    def _op_done(self, label):
        self.busy = False
        self.sub_title = f"完成: {label}"
        self.log_write(f"[TUI] —— {label} 结束 ——")
        self.set_hours()
        self.action_refresh(quiet=True)

    # ------------------------------------------------------------ 动作
    def _typing(self) -> bool:
        return isinstance(self.focused, Input)

    def action_refresh(self, quiet=False) -> None:
        if self.busy or self._typing():
            return
        table = self.query_one("#table", DataTable)
        table.clear()

        def runner():
            try:
                bot = self._ensure_bot()
                info = bot.hours_self()
                rows = bot.all_view_items()
                self.call_from_thread(self._fill_table, info, rows)
            except Exception as e:
                self.call_from_thread(self.log_write, f"[TUI] 刷新失败 {e}")

        if not quiet:
            self.log_write("[TUI] 刷新任务清单…")
        self.run_worker(runner, thread=True, name="refresh", group="io",
                        exclusive=True)

    def _fill_table(self, info, rows):
        self._view_rows = rows
        self._refill()

    def on_data_table_row_selected(self, event) -> None:
        """回车/点击表格行 → 小节详情 (skill: 事件驱动而非依赖全局绑定)。"""
        if not isinstance(self, StudyTUI):
            return          # 子屏幕的小节表冒泡防护 (id 检查亦可, 双保险)
        if event.data_table.id == "table":
            self.action_detail()

    def _selected(self):
        """返回当前选中行的完整视图行 {type,required,state,name,bid,runnable}。"""
        table = self.query_one("#table", DataTable)
        idx = table.cursor_row
        if idx is None or idx < 0 or idx >= len(self._shown_rows):
            return None
        return self._shown_rows[idx]

    def action_study(self) -> None:
        if self._typing():
            return
        row = self._selected()
        if not row or not row.get("bid"):
            self.log_write("[TUI] 先用方向键选中一行")
            return
        if not row.get("runnable"):
            self.log_write(f"[TUI] 「{row['type']}」类型{('已完成' if row['state'] == '已完成' else '不支持自动学习, ')}"
                           f"需要真实操作, 跳过")
            self.notify(f"「{row['type']}」需要真实操作, 无法自动完成",
                        severity="warning", timeout=4)
            return
        self.log_write(f"[TUI] 开始学习: {row['name'][:30]}")
        self._run_op(lambda bot: bot.run_course(row["bid"]), f"学习 {row['name'][:20]}")

    def action_study_all(self) -> None:
        if self._typing() or self.busy:
            return
        undone = [r for r in self._shown_rows if r["state"] in ("未开始", "学习中")]
        n = len(undone) if self.filter_key else None
        msg = ("即将逐个完成全部 未完成/未开始 的课程与专题, 可能耗时较长。\n"
               + (f"当前筛选下将处理 {n} 项。\n" if n else "")
               + "确认开始?")

        def confirmed(ok: bool) -> None:
            if not ok:
                self.notify("已取消", severity="warning", timeout=3)
                return
            self.log_write("[TUI] 开始完成全部 未完成/未开始 任务 (--todo)")
            self._run_op(lambda bot: bot.run_todo(), "完成全部")

        self.push_screen(ConfirmScreen(msg), callback=confirmed)

    def action_hours(self) -> None:
        if self.busy or self._typing():
            return
        self.input_mode = "hours"
        inp = self.query_one("#hours-input")
        inp.add_class("visible")
        inp.value = "auto"
        inp.placeholder = "学时数 (auto=自动补齐到要求线), 回车确认 / Esc 取消"
        inp.focus()

    def on_input_submitted(self, event) -> None:
        if not isinstance(self, StudyTUI):
            return          # 子屏幕冒泡防护
        if self.input_mode == "filter":
            event.input.remove_class("visible")
            self.input_mode = "hours"
            self.filter_key = (event.value or "").strip().lower()
            self.notify(f"筛选: {self.filter_key or '全部'} · "
                        f"{len(self._shown_rows)}/{len(self._view_rows)} 条",
                        timeout=3)
            self.log_write(f"[TUI] 筛选: {self.filter_key or '(全部)'}")
            self._refill()
            return
        if self.input_mode == "add":
            ok = self._add_step_advance(event.value or "")
            if ok and self.input_mode == "add":
                return                      # 还有下一步, 输入框保持
            event.input.remove_class("visible")
            return
        event.input.remove_class("visible")
        val = (event.value or "").strip()
        if self.input_mode == "user":
            self.input_mode = "hours"
            try:
                name = resolve_user(val or None)
            except SystemExit as e:
                self.log_write(f"[TUI] {e}")
                return
            mooc_client.set_user(name)
            self.user = mooc_client.get_user()
            self.bot = None          # 丢弃旧账号的客户端, 下次操作重建
            self.notify(f"已切换账号: {self._display_user()}", timeout=3)
            self.log_write(f"[TUI] 已切换账号 -> {self.user}, 按 r 刷新")
            self.action_refresh()
            return
        val = val or "auto"
        self.log_write(f"[TUI] 补网络自学学时: {val}")
        self._run_op(lambda bot: bot.run_hours(val if val != "auto" else "auto"),
                     f"学时 {val}")

    def on_key(self, event) -> None:
        if not isinstance(self, StudyTUI):
            return          # 子屏幕冒泡时跳过 (详情屏有自己的 Esc 绑定)
        if event.key == "escape":
            inp = self.query_one("#hours-input")
            if inp.has_class("visible"):
                inp.remove_class("visible")
                inp.password = False
                if self.input_mode == "filter" and self.filter_key:
                    self.filter_key = ""
                    self.log_write("[TUI] 已清除筛选")
                    self._refill()
                self.input_mode = "hours"

    def action_toggle_done(self) -> None:
        if self._typing() or self.busy:
            return
        self.show_done = not self.show_done
        self.notify("已显示完成任务" if self.show_done else "已隐藏完成任务", timeout=3)
        self._refill()

    def action_detail(self) -> None:
        if self._typing() or self.busy:
            return
        row = self._selected()
        if not row or not row.get("bid"):
            self.log_write("[TUI] 先用方向键选中一行")
            return
        if row["type"] not in ("课程", "专题"):
            self.notify("该类型没有小节列表", severity="warning", timeout=3)
            return
        if self.bot is None:
            self._ensure_bot()
        self.push_screen(SectionScreen(row, self.bot))

    def action_sort(self) -> None:
        if self._typing() or self.busy:
            return
        self.sort_mode = (self.sort_mode + 1) % len(SORT_MODES)
        self.notify(f"排序: {SORT_MODES[self.sort_mode][0]}", timeout=3)
        self._refill()

    def action_filter(self) -> None:
        if self.busy or self._typing():
            return
        self.input_mode = "filter"
        inp = self.query_one("#hours-input")
        inp.add_class("visible")
        inp.password = False
        inp.value = self.filter_key
        inp.placeholder = "搜索任务: 关键词匹配 名称/类型/状态 (回车应用, Esc 清除)"
        inp.focus()

    def action_add_account(self) -> None:
        if self.busy or self._typing():
            return
        self.input_mode = "add"
        self.add_step = 0
        inp = self.query_one("#hours-input")
        inp.add_class("visible")
        inp.value = ""
        inp.password = False
        inp.placeholder = "[1/2] 登录用户名 (回车下一步, Esc 取消)"
        inp.focus()

    def _add_step_advance(self, value):
        """三步录入: 名 → 用户名 → 密码(掩码)。"""
        inp = self.query_one("#hours-input")
        value = value.strip()
        if self.add_step == 0:
            if not value:
                return False
            self._add_username = value
            self.add_step = 1
            inp.value = ""
            inp.password = True
            inp.placeholder = "[2/2] 登录密码 (输入不回显)"
        else:
            path = env_add_account(self._add_username, value)
            inp.password = False
            self.input_mode = "hours"
            self.log_write(f"[TUI] 账号 {self._add_username} 已写入 {path} (显示名登录后自动取平台真实姓名)")
            self.action_refresh()
        return True

    def action_user(self) -> None:
        if self.busy or self._typing():
            return
        self.input_mode = "user"
        inp = self.query_one("#hours-input")
        inp.add_class("visible")
        inp.value = ""
        inp.placeholder = "账号名(支持前缀), 回车切换 / Esc 取消"
        inp.focus()

    def action_dryrun(self) -> None:
        if self._typing():
            return
        self.dry_run = not self.dry_run
        if self.bot:
            self.bot.dry_run = self.dry_run
        self.notify(("DRY-RUN 开: 只体检不上报" if self.dry_run else "DRY-RUN 关: 会真实上报"),
                    severity="warning" if not self.dry_run else "information", timeout=4)
        self.log_write(f"[TUI] dry-run = {self.dry_run}")
        self.set_hours()


def main():
    ap = argparse.ArgumentParser(description="自动学习 TUI")
    ap.add_argument("--mode", choices=("auto", "audio", "video"), default="auto")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--user", metavar="账号", default=None,
                    help="多账号: accounts.json 中的账号名 (支持前缀)")
    a = ap.parse_args()
    StudyTUI(mode=a.mode, dry_run=a.dry_run, user=a.user).run()


if __name__ == "__main__":
    main()
