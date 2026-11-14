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
import os
import platform
import subprocess
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
from mooc_auto_study import (DONE_FINISH, FINISH_NAME, QuotaExhausted, StudyBot,
                              _today_capacity, resolve_user, today_used)

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
_STATE_ORDER = {"未开始": 0, "学习中": 1, "已完成(复习)": 2, "已完成": 2, "已过期": 3}
_TYPE_ORDER = {"课程": 0, "专题": 1, "班级": 2, "考试": 3, "调研": 4, "直播": 5}
def _visible(r, show_done: bool) -> bool:
    """是否在列表里显示。完成态有两个标签（已完成 / 已完成(复习)），必须按前缀判断。"""
    return show_done or not str(r.get("state") or "").startswith("已完成")


def _is_done(r):
    s = str(r.get("state") or "")
    return s.startswith("已完成") or s == "已过期"


# 上次学习时间(lastAccessTime)已被剔除: 它是"上次访问时间", 本工具的任何
# API 调用都会改写它 —— 数据污染, 不可作为排序/展示依据。
# 排序仅使用干净要素: 要求 / 状态 / 推送时间 / 注册时间。
AUTO_WIDTH = True       # True=DataTable 自适应测宽(实验) / False=显式固定列宽
# 表格列: 名称=0 表示宽度自适应；窄屏按 COLUMNS 顺序裁剪尾部列
COLUMNS = [("类型", 6), ("要求", 4), ("状态", 6), ("名称", 0),
           ("推送时间", 12), ("id", 11), ("URL", 20)]


def columns_for(width: int) -> list[str]:
    """按终端宽度决定显示哪些列（手机 SSH 常见 40~60 列，只留前四列）。"""
    keys = ["类型", "要求", "状态", "名称"]
    if width >= 66:
        keys.append("推送时间")
    if width >= 78:
        keys.append("id")
    if width >= 94:
        keys.append("URL")
    return keys


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


def open_image(path: str) -> None:
    """用系统默认看图程序打开二维码 PNG —— 手机扫屏幕上的图片最稳（不受终端字体影响）。"""
    if not path or not os.path.exists(path):
        raise FileNotFoundError(path or "(空路径)")
    system = platform.system()
    if system == "Windows":
        os.startfile(path)                     # noqa: S606 - Windows 专有
    elif system == "Darwin":
        subprocess.Popen(["open", path])
    else:
        subprocess.Popen(["xdg-open", path])


class QRScreen(ModalScreen[None]):
    """全屏展示 APP / 微信二维码：日志面板高度不够时也能完整看到。

    尺寸按终端自适应：半块字符的高度是宽度的一半，所以单张宽度取
    min((宽-8)/2, (高-6)*2)，两种约束同时满足，不会被裁切。
    """

    CSS = """
    QRScreen { align: center middle; background: $background; }
    #qr-title { text-align: center; padding: 1 0 0 0; }
    #qr-body { text-align: center; }
    #qr-hint { text-align: center; color: $text-muted; padding: 1 0; }
    """

    BINDINGS = [Binding("escape", "dismiss_screen", "返回"),
                Binding("q", "dismiss_screen", "返回"),
                Binding("1", "show_app", "APP 码", show=False),
                Binding("2", "show_wechat", "微信码", show=False),
                Binding("tab", "toggle_kind", "切换码", show=False),
                Binding("i", "toggle_invert", "反色", show=False),
                Binding("o", "open_image", "打开图片", show=False)]

    def __init__(self, note: str = "") -> None:
        super().__init__()
        self.pngs = {}
        self.note = note
        self.kind = "app"          # 小屏时只显示这一张
        self.last_art = ""
        self.last_title = ""
        self.paths = {}            # {kind: PNG 落盘路径}
        self.invert = False        # 正色（白块亮）默认；浅色终端可按 i 切反色

    def action_show_app(self) -> None:
        self.kind = "app"
        self.paint()

    def action_show_wechat(self) -> None:
        self.kind = "wechat"
        self.paint()

    def action_open_image(self) -> None:
        """用看图程序打开 PNG（手机直接扫电脑屏幕上的图，最可靠）。"""
        kind = self.kind if self.kind in self.paths else next(iter(self.paths), None)
        path = self.paths.get(kind) if kind else None
        if not path:
            self.notify("还没有落盘的图片，等码出来再试", severity="warning", timeout=3)
            return
        try:
            open_image(path)
            self.notify(f"已打开 {os.path.basename(path)}，用手机扫图片窗口", timeout=4)
        except (Exception, OSError) as e:
            self.notify(f"打不开图片：{e}（路径 {path}）", severity="error", timeout=6)

    def action_toggle_invert(self) -> None:
        self.invert = not self.invert
        self.paint()

    def action_toggle_kind(self) -> None:
        self.kind = "wechat" if self.kind == "app" else "app"
        self.paint()

    def compose(self) -> ComposeResult:
        yield Static("", id="qr-title")
        yield Static("", id="qr-body")
        yield Static("", id="qr-hint")

    def on_mount(self) -> None:
        self.paint()

    def on_resize(self, event) -> None:
        self.paint()

    def action_dismiss_screen(self) -> None:
        try:
            self.dismiss()      # 后台仍继续等扫码，只是关掉这一屏
        except Exception:
            pass                # 已关闭（成功/超时先关过）时忽略

    def update_pngs(self, pngs: dict, note: str = "", paths: dict | None = None) -> None:
        self.pngs = dict(pngs)
        self.note = note or ""          # 总是覆盖：否则「另一张码还在取」会一直挂着
        if paths is not None:
            self.paths = dict(paths)
        if self.is_mounted:
            self.paint()

    def paint(self) -> None:
        import mooc_api_login as m

        width, height = self.size.width, self.size.height
        avail_h = max(8, height - 6)                  # 标题 / 提示 / 上下边距
        # 二维码不能缩放（缩放后扫不出来），先探测真实模块数再决定怎么摆
        need = 0
        for png in self.pngs.values():
            try:
                need = max(need, m.qr_modules(png))
            except (Exception, SystemExit):
                need = 0
        want_pair = len(self.pngs) == 2
        can_pair = (want_pair and need * 2 + 3 <= width - 2
                    and need // 2 + 1 <= avail_h)
        can_single = need <= width - 2 and need // 2 + 1 <= avail_h
        n = need if need else 21
        title = self.query_one("#qr-title", Static)
        body = self.query_one("#qr-body", Static)
        hint = self.query_one("#qr-hint", Static)
        try:
            if can_pair:
                art = m.qr_ascii_pair(self.pngs["app"], self.pngs["wechat"],
                                      max_width=n, invert=self.invert)
                col = (len(art.splitlines()[0]) - 3) // 2
                title_text = "APP 扫码".center(col) + "   " + "微信扫码".center(col)
                title.update(title_text)
                self.last_title = title_text
            elif can_single and self.pngs:
                kind = self.kind if self.kind in self.pngs else next(iter(self.pngs))
                art = m.qr_ascii(self.pngs[kind], max_width=n, invert=self.invert)
                title_text = (("▶ APP 码" if kind == "app" else "▶ 微信码")
                              + "   （1=APP / 2=微信 / Tab 切换）") if len(self.pngs) == 2 \
                             else ("APP 扫码" if kind == "app" else "微信扫码")
                title.update(title_text)
                self.last_title = title_text
            elif self.pngs:
                # 终端装不下完整二维码：宁可让用户扫 PNG，也不显示一张扫不出的残码
                kind = next(iter(self.pngs))
                path = self.paths.get(kind, "")
                art = (f"终端太窄：二维码需要 {n} 列 × {n // 2 + 1} 行，"
                       f"当前 {width} × {height}。\n\n请打开图片扫码：\n{path or '(未落盘，请调宽终端后重试)'}")
                title_text = "二维码超出终端尺寸"
                title.update(title_text)
                self.last_title = title_text
                title.update("APP 扫码" if kind == "app" else "微信扫码")
            else:
                art = ""
                title_text = "扫码登录 · 正在取码…"
                title.update(title_text)
                self.last_title = title_text
        except (Exception, SystemExit) as e:
            art = f"字符画渲染失败：{e}"
        self.last_art = art                     # 便于测试与外部取用
        body.update(Text(art))
        if self.pngs and not can_pair and not can_single:
            tip = f"码需要 {n} 列，终端仅 {width} 列 · 请扫 PNG 或调宽终端 · Esc 返回"
        elif len(self.pngs) == 2 and not can_pair:
            tip = "小屏一次一张：1=APP 2=微信 · o 打开图片 · Esc 返回"
        elif len(self.pngs) == 2:
            tip = "扫任意一张即可登录 · o 打开图片 · i 正/反色 · Esc 返回"
        elif len(self.pngs) == 1:
            tip = "另一张码还在取… · Esc 返回"
        else:
            tip = "正在取码… · Esc 返回"
        hint.update(self.note or tip)


class SectionScreen(Screen):
    """小节列表详情 (回车进入, Esc 返回)。"""

    CSS = """
    SectionScreen { layout: vertical; background: $surface-darken-1; }
    #sec-title { dock: top; height: auto; padding: 1 2;
                 background: $panel; border: round $primary; }
    #sec-table { height: 1fr; margin: 0 1 0 1; border: round $primary; }
    #sec-log { height: 8; margin: 0 1 1 1; border: round $secondary;
               border-title-align: left; padding: 0 1; background: $surface; }
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
        log = RichLog(id="sec-log", markup=False, wrap=True, highlight=False)
        log.border_title = "运行日志"
        yield log
        yield Footer()

    def append_log(self, text: str) -> None:
        """接收主界面的日志（学习进度/上报结果），保持在详情页也能看到。"""
        try:
            self.query_one("#sec-log", RichLog).write(_styled(text))
        except Exception:
            pass

    def on_button_pressed(self, event) -> None:
        """按钮栏点击（鼠标/触摸）→ 走与快捷键相同的 action。"""
        if not isinstance(self, StudyTUI):
            return
        if getattr(self, "busy", False) and event.button.id not in ("btn-quit",):
            self.log_write("[TUI] 正在运行任务，稍候再点")
            return
        action = next((a for bid, _l, a, _w in self.TOOLBAR
                       if bid == event.button.id), None)
        if action:
            getattr(self, f"action_{action}")()

    def _sync_toolbar(self) -> None:
        """窄屏（手机）只留前 6 个按钮，其余按宽度显示。"""
        width = self.size.width
        narrow = width < 60                 # 手机上用单字标签，7 个按钮也放得下
        for bid, label, _action, need in self.TOOLBAR:
            try:
                btn = self.query_one(f"#{bid}", Button)
            except Exception:
                continue
            btn.display = width >= need
            btn.label = self.TOOLBAR_SHORT.get(bid, label[:1]) if narrow else label

    def on_resize(self, event) -> None:
        """终端尺寸变化 → 重算名称列宽并重绘 (数据已在内存, 无网络请求)。"""
        if not isinstance(self, StudyTUI):
            return          # 子屏幕(如小节详情)冒泡触发时 self 不是主界面
        self._sync_toolbar()
        if self._view_rows and not self.busy:
            self._refill()

    def on_mount(self) -> None:
        # 先把进屏前的历史日志补上，避免详情页日志一片空白
        try:
            for line in getattr(self.app, "_log_buffer", [])[-60:]:
                self.append_log(line)
        except Exception:
            pass
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
        except (Exception, SystemExit) as e:
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
            state = FINISH_NAME.get(fin, str(fin))
            style = ("yellow" if state == "未开始" else
                     "dodger_blue" if state == "学习中" else
                     "spring_green" if state.startswith("已完成") else "")
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
    #toolbar {
        height: 1; background: $panel; align-horizontal: center;
        padding: 0;
    }
    #toolbar Button {
        height: 1; min-width: 5; margin: 0 0; padding: 0 1;
        border: none; background: $panel; color: $text;
    }
    #toolbar Button:hover { background: $primary 40%; }
    #toolbar Button:focus { background: $primary; color: $text; }
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
        Binding("Q", "qr_login", "扫码登录"),
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
        self._qr_pngs = {}               # 双通道扫码: {"app": png, "wechat": png}
        self._qr_paths = {}              # {"app": /path/mooc-qr-app.png, ...}
        self._log_buffer = []            # 最近日志（详情屏进入时回填）
        self._qr_screen = None            # 全屏二维码页
        mooc_client.set_user(resolve_user(user))
        self.user = mooc_client.get_user()

    # ------------------------------------------------------------ UI 组装
    TOOLBAR = [
        # (id, 标签, 对应 action, 需要的最小宽度)
        ("btn-refresh", "刷新", "refresh", 0),
        ("btn-filter", "搜索", "filter", 0),
        ("btn-study", "学习", "study", 0),
        ("btn-all", "全部", "study_all", 0),
        ("btn-today", "今日", "today", 0),
        ("btn-logs", "记录", "logs", 0),
        ("btn-hours", "学时", "hours", 0),
        ("btn-quit", "退出", "quit", 0),
        ("btn-sort", "排序", "sort", 72),
        ("btn-done", "显隐", "toggle_done", 78),
        ("btn-user", "账号", "user", 84),
        ("btn-qr", "扫码", "qr_login", 90),
    ]
    # 窄屏单字标签（"学习"与"学时"首字相同，必须显式给短名）
    TOOLBAR_SHORT = {"btn-refresh": "刷", "btn-filter": "搜", "btn-study": "学",
                     "btn-all": "全", "btn-today": "今", "btn-logs": "记", "btn-hours": "时",
                     "btn-quit": "退", "btn-sort": "序", "btn-done": "隐",
                     "btn-user": "号", "btn-qr": "码"}

    def compose(self) -> ComposeResult:
        yield Header(show_clock=True)
        yield Static("", id="hours")
        with Horizontal(id="toolbar"):
            for bid, label, _action, _w in self.TOOLBAR:
                yield Button(label, id=bid, classes="tb")
        yield DataTable(id="table", cursor_type="row", zebra_stripes=True)
        yield RichLog(id="log", markup=False, wrap=True, highlight=False)
        yield Input(id="hours-input")
        yield Footer()

    def on_button_pressed(self, event) -> None:
        """按钮栏点击（鼠标/触摸）→ 走与快捷键相同的 action。"""
        if not isinstance(self, StudyTUI):
            return
        if getattr(self, "busy", False) and event.button.id not in ("btn-quit",):
            self.log_write("[TUI] 正在运行任务，稍候再点")
            return
        action = next((a for bid, _l, a, _w in self.TOOLBAR
                       if bid == event.button.id), None)
        if action:
            getattr(self, f"action_{action}")()

    def _sync_toolbar(self) -> None:
        """窄屏（手机）只留前 6 个按钮，其余按宽度显示。"""
        width = self.size.width
        narrow = width < 60                 # 手机上用单字标签，7 个按钮也放得下
        for bid, label, _action, need in self.TOOLBAR:
            try:
                btn = self.query_one(f"#{bid}", Button)
            except Exception:
                continue
            btn.display = width >= need
            btn.label = self.TOOLBAR_SHORT.get(bid, label[:1]) if narrow else label

    def on_resize(self, event) -> None:
        """终端尺寸变化 → 重算名称列宽并重绘 (数据已在内存, 无网络请求)。"""
        if not isinstance(self, StudyTUI):
            return          # 子屏幕(如小节详情)冒泡触发时 self 不是主界面
        self._sync_toolbar()
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
        self._sync_toolbar()
        self.action_refresh()

    # ------------------------------------------------------------ 工具
    def log_write(self, text: str) -> None:
        self.query_one("#log", RichLog).write(_styled(text))
        buf = getattr(self, "_log_buffer", None)
        if buf is not None:
            buf.append(text)
            del buf[:-300]                 # 只留最近 300 行，避免无限增长
        try:                               # 小节详情屏开着时同步一份
            screen = self.screen
            if isinstance(screen, SectionScreen):
                screen.append_log(text)
        except Exception:
            pass

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
        if self.size.width < 60:                      # 手机窄屏: 只留最短提示
            base = f"任务 · {sort_label.split(':')[0]}"
        else:
            base = (f"任务列表 · 排序: {sort_label} "
                    f"(回车 进入小节列表 · o 排序 · / 搜索 · s 学习选中 · a 完成全部)")
        if self.filter_key:
            base += f" · 筛选: {self.filter_key!r} ({len(self._shown_rows)}/{len(self._view_rows)})"
        self.query_one("#table", DataTable).border_title = base

    def _refill(self) -> None:
        """按 filter_key 过滤 _view_rows 并重绘表格。"""
        table = self.query_one("#table", DataTable)
        table.clear()
        fk = self.filter_key
        shown = [r for r in self._view_rows
                 if _visible(r, self.show_done)
                 and (not fk or any(fk in str(r.get(k, "")).lower()
                                    for k in ("name", "type", "state", "required", "bid")))]
        self._shown_rows = shown
        from collections import Counter
        cnt = Counter(r["state"] for r in shown)
        info = self.bot.hours_self() if self.bot else {}
        self.query_one("#hours", Static).update(
            self._hours_text(info, self.dry_run, self.mode, cnt, self._display_user()))
        shown.sort(key=SORT_MODES[self.sort_mode][1])
        # 窄屏按宽度裁剪次要列（textual 8 没有列可见性，直接重建列集合）
        width = self.size.width
        want = columns_for(width)
        if list(table.columns.keys()) != want:
            table.clear(columns=True)
            for key, w in COLUMNS:
                if key in want:
                    table.add_column(key, width=w, key=key)
        # 名称列宽自适应: 按当前可见行最长的名称计算, 上限受终端宽度约束
        others = sum(w for k, w in COLUMNS if k in want and w)  # 其余固定列宽合计
        avail = max(32, width - 8) - others
        name_w = min(60, max(14, min(avail,
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
            cell = {
                "类型": lambda: Text(r["type"]),
                "要求": lambda: Text(r["required"], req_style),
                "状态": lambda: state_cell,
                "名称": lambda: fit_text(r.get("name") or "", name_w),
                "推送时间": lambda: pts_text,
                "id": lambda: Text((r["bid"] or "")[:8] + "…", "grey50"),
                "URL": lambda: Text((r.get("url") or "")[:17], "grey50"),
            }
            table.add_row(*(cell[k]() for k in want), key=r["_rk"])
        self._update_table_title()

    def _display_user(self) -> str:
        """账号显示名: 优先平台真实姓名。"""
        import mooc_api_login as m
        tok = m._read_token(self.user) or {}
        return tok.get("display_name") or self.user

    def set_hours(self) -> None:
        try:
            info = self.bot.hours_self() if self.bot else {}
        except (Exception, SystemExit) as e:
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
            except (Exception, SystemExit) as e:
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
            except (Exception, SystemExit) as e:
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

    def action_logs(self) -> None:
        """学习记录：最近 7 天学过/在学的课程与专题（CLI --logs 的等价物）。"""
        if self.busy or self._typing():
            return
        self.log_write("[记录] 拉取最近 7 天学习记录…")

        def work():
            try:
                bot = self._ensure_bot()
                merged = {}
                for r in bot.course_logs(0, 7) + bot.course_logs(2, 7):
                    merged[r.get("id")] = r          # businessType 0/2 会重叠
                rows = sorted(merged.values(),
                              key=lambda x: x.get("lastAccessTime") or 0, reverse=True)
                self.call_from_thread(self._show_logs, rows)
            except (Exception, SystemExit) as e:
                self.call_from_thread(self.log_write, f"[记录] 读取失败 {type(e).__name__}: {e}")

        self.run_worker(work, thread=True, name="logs", group="io")

    def _show_logs(self, rows) -> None:
        import datetime as _dt
        self.log_write(f"[记录] 最近 7 天 {len(rows)} 条")
        for r in rows[:20]:
            la = r.get("lastAccessTime")
            ts = _dt.datetime.fromtimestamp(la / 1000).strftime("%m-%d %H:%M") if la else "  —  "
            name = (r.get("courseInfo") or {}).get("name") or ""
            fs = r.get("finishStatus")
            state = ("已学完" if fs in DONE_FINISH
                     else {0: "未开始", 1: "学习中"}.get(fs, str(fs)))
            self.log_write(f"  {ts}  {state:4s}  {(r.get('studyTotalTime') or 0) / 3600:5.2f}h  {name[:36]}")

    def action_today(self) -> None:
        """今日额度：min(工作档位容量 − 今日已学, 学时缺口)，与 CLI --today 同源。"""
        if self.busy or self._typing():
            return
        try:
            info = self.bot.hours_self() if self.bot else {}
            got = float(info.get("hourSelf") or 0)
            need = float(info.get("requireCourseHour") or 0)
            cap, prof = _today_capacity()
            used = today_used(got if got else None)
            quota = min(max(0.0, cap - used), max(0.0, need - got))
        except (Exception, SystemExit) as e:
            self.log_write(f"[今日] 计算失败 {type(e).__name__}: {e}")
            return
        self.log_write(f"[今日] 档位「{prof.get('label') or '默认'}」容量 {cap:.2f}"
                       f" | 今日已学 {used:.2f} | 网络自学 {got:.2f}/{need:.2f}")
        if quota <= 0:
            self.log_write("[今日] ✅ 今天不用再学（容量已用满或学时已达标）")
            self.notify("今天不用再学", timeout=3)
            return
        self.log_write(f"[今日] 目标 {quota:.2f} 学时，学完即停")
        self._run_op(lambda bot: bot.run_hours(str(round(quota, 2))), "今日学时")

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
        if self.input_mode == "qr":
            self.input_mode = "hours"
            event.input.remove_class("visible")      # 收起输入框，别把后续回车当成学时
            kind = (event.value or "app").strip().lower() or "app"
            if kind not in ("app", "wechat"):
                kind = "app"
            self.busy = True                         # 扫码期间不学习、不切账号
            self.sub_title = "扫码登录中…"
            self.log_write(f"[扫码] 取码中（{kind}）…")
            self.run_worker(lambda: self._qr_flow(kind), thread=True, name="qr")
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

    def action_qr_login(self) -> None:
        """同时取 APP / 微信两张码，扫任意一张即可。"""
        if self.busy or self._typing():
            return
        self.busy = True
        self.sub_title = "扫码登录中…"
        self._qr_pngs = {}
        self._qr_paths = {}
        self.log_write("[扫码] 兜底通道：同时取 APP / 微信两张码（推荐用账密登录，有效期 30 天）")
        self._qr_screen = QRScreen()
        self.push_screen(self._qr_screen)
        self.run_worker(self._qr_flow, thread=True, name="qr")

    def _qr_flow(self) -> None:
        """两路并发轮询；55 秒过期由 qr_login_both 自动换新（各最长 3 轮）。"""
        import mooc_api_login as m

        def on_qr(kind, cycle, png, uid):
            self.call_from_thread(self._qr_show, kind, cycle, png, uid)

        def on_error(kind, msg):
            label = "APP" if kind == "app" else "微信"
            self.call_from_thread(self.log_write, f"[扫码] ⚠️ {label}: {msg}")
            screen = getattr(self, "_qr_screen", None)
            if screen is not None and screen.is_mounted:
                self.call_from_thread(screen.update_pngs, screen.pngs, msg)

        try:
            _tok, key, kind = m.qr_login_both(ttl=55, cycles=3, on_qr=on_qr,
                                             on_error=on_error)
        except (Exception, SystemExit) as e:
            self.call_from_thread(self.log_write, f"[扫码] 失败 {type(e).__name__}: {e}")
            self.call_from_thread(self._qr_finish)
            return
        self.call_from_thread(self._qr_done, key, kind)

    def _qr_show(self, kind: str, cycle: int, png: bytes, uid: str) -> None:
        import mooc_auto_study
        # QR 落盘到数据目录(TOBACCO_HOME 或 data/), 不写仓库目录
        base = mooc_auto_study._today_used_path().parent
        os.makedirs(base, exist_ok=True)
        path = os.path.join(str(base), f"mooc-qr-{kind}.png")
        try:
            with open(path, "wb") as f:
                f.write(png)
        except OSError:
            path = ""
        self._qr_pngs[kind] = png
        if path:
            self._qr_paths[kind] = path
        hint = "APP → 右上角扫一扫" if kind == "app" else "微信 → 右上角 + → 扫一扫"
        self.log_write(f"[扫码] {hint} · 第 {cycle} 张 · 55 秒后自动换新"
                       + (f" · 图片 {path}" if path else ""))
        screen = getattr(self, "_qr_screen", None)
        if screen is not None:
            # 码可能在屏幕挂载完成前就返回，这里先存数据，paint 由 screen 自己按需触发
            note = "" if len(self._qr_pngs) == 2 else "另一张码还在取，稍等…"
            screen.update_pngs(self._qr_pngs, note, self._qr_paths)

    def _qr_finish(self) -> None:
        self._qr_pngs = {}
        self._qr_paths = {}
        screen = getattr(self, "_qr_screen", None)
        self._qr_screen = None
        if screen is not None and screen.is_mounted and self.screen is screen:
            try:
                screen.dismiss()
            except Exception:
                pass
        self.busy = False
        self.sub_title = "扫码登录结束"

    def _qr_done(self, key: str, kind: str = "app") -> None:
        self._qr_finish()
        mooc_client.set_user(key)
        self.user = mooc_client.get_user()
        self.bot = None                      # 旧账号的客户端作废
        self.notify(f"扫码登录成功: {key}", timeout=4)
        label = "APP" if kind == "app" else "微信"
        self.log_write(f"[扫码] ✅ {label}扫码登录成功，账号 {key}，token 已缓存")
        self.action_refresh()

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
