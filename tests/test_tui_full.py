# -*- coding: utf-8 -*-
"""TUI 全功能 headless 测试：12 个快捷键 + 小节详情 + 输入框流程，全部离线打桩。

用 textual 的 app.run_test() 真起应用（会跑 compose/mount/worker），
StudyBot / 账号写入 / 扫码全部替换成假实现，不联网、不碰真实凭证。
"""
import asyncio

import pytest

import mooc_api_login
import mooc_tui

ROWS = [
    {"type": "课程", "required": "必修", "state": "学习中", "name": "必修-学习中",
     "bid": "b1", "runnable": True, "reg_ts": 0, "push_ts": 2000, "url": ""},
    {"type": "课程", "required": "选修", "state": "已完成", "name": "选修-已完成",
     "bid": "b2", "runnable": True, "reg_ts": 0, "push_ts": 1000, "url": ""},
    {"type": "考试", "required": "—", "state": "未开始", "name": "资格考试",
     "bid": "b3", "runnable": False, "reg_ts": 0, "push_ts": 500, "url": ""},
]

SECTIONS = [
    {"section_id": "s1", "resource_id": "r1", "name": "第一节", "type": 6, "finish": 2, "rate": 100},
    {"section_id": "s2", "resource_id": "r2", "name": "第二节", "type": 6, "finish": 0, "rate": 0},
]


class FakeBot:
    """StudyBot 的最小替身：记录调用，返回固定数据。"""

    instances = []

    def __init__(self, *a, **k):
        self.dry_run = k.get("dry_run", False)
        self.mode = k.get("mode", "auto")
        self.stop_reason = None
        self.calls = []
        FakeBot.instances.append(self)

    def hours_self(self):
        return {"hourSelf": 10.0, "requireCourseHour": 50, "hourTrain": 5}

    def all_view_items(self):
        return [dict(r) for r in ROWS]

    def sections(self, bid, vid="", reg=False):
        self.calls.append(("sections", bid))
        return [dict(s) for s in SECTIONS]

    def _req(self, *a, **k):
        return (200, {})

    def run_course(self, bid, **k):
        self.calls.append(("run_course", bid))

    def run_todo(self, **k):
        self.calls.append(("run_todo",))

    def run_hours(self, hours="auto", **k):
        self.calls.append(("run_hours", hours))

    def course_logs(self, business_type=0, days=7):
        return [{"id": f"r{business_type}", "lastAccessTime": 1793874000000,
                 "finishStatus": 1, "studyTotalTime": 3600,
                 "courseInfo": {"name": f"课程{business_type}"}}]

    def close(self):
        pass


@pytest.fixture
def fake(monkeypatch):
    FakeBot.instances = []
    monkeypatch.setattr(mooc_tui, "StudyBot", FakeBot)
    monkeypatch.setattr(mooc_tui.mooc_client, "fresh_token", lambda force=False: {"access_token": "x"})
    yield FakeBot


def _run(coro_factory):
    asyncio.run(coro_factory())


def _log(app) -> str:
    return "\n".join(str(line) for line in app.query_one("#log").lines)


def test_startup_renders_default_hides_done(fake):
    async def main():
        app = mooc_tui.StudyTUI()
        async with app.run_test(size=(120, 40)) as pilot:
            await pilot.pause(0.2)
            assert len(app._view_rows) == 3
            # 默认隐藏已完成 → 只剩 2 行
            assert len(app._shown_rows) == 2
            assert "已完成" not in [r["state"] for r in app._shown_rows]
            hours = app._hours_text({"hourSelf": 10.0, "requireCourseHour": 50, "hourTrain": 5},
                                    False, "auto", {"未开始": 1, "学习中": 1}, "default")
            assert "网络自学" in hours and "50" in hours
    _run(main)


def test_refresh_key(fake):
    async def main():
        app = mooc_tui.StudyTUI()
        async with app.run_test(size=(120, 40)) as pilot:
            await pilot.press("r")
            await pilot.pause(0.3)
            assert len(app._view_rows) == 3
    _run(main)


def test_filter_key(fake):
    async def main():
        app = mooc_tui.StudyTUI()
        async with app.run_test(size=(120, 40)) as pilot:
            await pilot.press("slash")
            await pilot.pause(0.1)
            inp = app.query_one("#hours-input")
            assert inp.has_class("visible")
            inp.value = "资格"
            await pilot.press("enter")
            await pilot.pause(0.2)
            assert len(app._shown_rows) == 1
            assert app._shown_rows[0]["name"] == "资格考试"
            # 清空筛选恢复
            app.action_filter()
            await pilot.pause(0.1)
            app.query_one("#hours-input").value = ""
            await pilot.press("enter")
            await pilot.pause(0.2)
            assert len(app._shown_rows) == 2
    _run(main)


def test_sort_cycles(fake):
    async def main():
        app = mooc_tui.StudyTUI()
        async with app.run_test(size=(120, 40)) as pilot:
            n = len(mooc_tui.SORT_MODES)
            for i in range(n):
                assert app.sort_mode == i
                await pilot.press("o")
                await pilot.pause(0.05)
            assert app.sort_mode == 0          # 转一圈回到默认
    _run(main)


def test_toggle_done(fake):
    async def main():
        app = mooc_tui.StudyTUI()
        async with app.run_test(size=(120, 40)) as pilot:
            assert app.show_done is False
            await pilot.press("x")
            await pilot.pause(0.15)
            assert app.show_done is True
            assert len(app._shown_rows) == 3
            await pilot.press("x")
            await pilot.pause(0.15)
            assert len(app._shown_rows) == 2
    _run(main)


def test_dryrun_toggle(fake):
    async def main():
        app = mooc_tui.StudyTUI()
        async with app.run_test(size=(120, 40)) as pilot:
            before = app.dry_run
            await pilot.press("d")
            await pilot.pause(0.2)
            assert app.dry_run is (not before)
    _run(main)


def test_study_selected_calls_run_course(fake):
    async def main():
        app = mooc_tui.StudyTUI()
        async with app.run_test(size=(120, 40)) as pilot:
            await pilot.pause(0.2)
            table = app.query_one("#table")
            table.move_cursor(row=0)
            await pilot.pause(0.05)
            await pilot.press("s")
            await pilot.pause(0.4)
            bot = app.bot
            assert bot is not None
            assert ("run_course", "b1") in bot.calls
    _run(main)


def test_study_skips_exam_row(fake):
    async def main():
        app = mooc_tui.StudyTUI()
        async with app.run_test(size=(120, 40)) as pilot:
            await pilot.pause(0.2)
            app._selected = lambda: dict(ROWS[2])    # 选中考试行
            app.action_study()
            await pilot.pause(0.2)
            assert "需要真实操作" in _log(app)
            assert app.bot is None or not any(c[0] == "run_course" for c in app.bot.calls)
    _run(main)


def test_study_all_confirm_then_run_todo(fake):
    async def main():
        app = mooc_tui.StudyTUI()
        async with app.run_test(size=(120, 40)) as pilot:
            await pilot.pause(0.2)
            await pilot.press("a")
            await pilot.pause(0.15)
            from textual.widgets import Button
            btn = app.screen.query_one("#yes", Button)
            await pilot.click(btn)
            await pilot.pause(0.4)
            bot = app.bot
            assert bot is not None and ("run_todo",) in bot.calls
    _run(main)


def test_hours_input_sets_run_hours(fake):
    async def main():
        app = mooc_tui.StudyTUI()
        async with app.run_test(size=(120, 40)) as pilot:
            await pilot.pause(0.2)
            await pilot.press("h")
            await pilot.pause(0.1)
            inp = app.query_one("#hours-input")
            assert inp.has_class("visible")
            inp.value = "5"
            await pilot.press("enter")
            await pilot.pause(0.4)
            bot = app.bot
            assert bot is not None and ("run_hours", "5") in bot.calls
    _run(main)


def test_add_account_three_steps(fake, monkeypatch):
    written = {}
    monkeypatch.setattr(mooc_tui, "env_add_account",
                        lambda name, pwd: written.update(name=name, pwd=pwd) or "/tmp/acc.json")

    async def main():
        app = mooc_tui.StudyTUI()
        async with app.run_test(size=(120, 40)) as pilot:
            await pilot.pause(0.2)
            await pilot.press("n")
            await pilot.pause(0.1)
            inp = app.query_one("#hours-input")
            inp.value = "work"
            await pilot.press("enter")
            await pilot.pause(0.1)
            assert inp.password is True              # 第二步: 密码掩码
            inp.value = "secret"
            await pilot.press("enter")
            await pilot.pause(0.3)
            assert written == {"name": "work", "pwd": "secret"}
            assert "已写入" in _log(app)
    _run(main)


def test_qr_login_missing_dep_does_not_crash(fake, monkeypatch):
    def boom(**k):
        raise SystemExit("缺少依赖：pip install qrcode pillow（uv 环境用 uv pip install qrcode pillow）")

    monkeypatch.setattr(mooc_api_login, "qr_login_both", boom)

    async def main():
        app = mooc_tui.StudyTUI()
        async with app.run_test(size=(120, 40)) as pilot:
            await pilot.pause(0.2)
            await pilot.press("Q")
            await pilot.pause(0.5)
            assert "缺少依赖" in _log(app)
            assert app.busy is False                 # 收尾复位，界面可用
    _run(main)


def test_detail_screen_shows_sections(fake):
    async def main():
        app = mooc_tui.StudyTUI()
        async with app.run_test(size=(120, 40)) as pilot:
            await pilot.pause(0.2)
            app.query_one("#table").move_cursor(row=0)
            await pilot.pause(0.05)
            await pilot.press("enter")
            await pilot.pause(0.5)
            assert isinstance(app.screen, mooc_tui.SectionScreen)
            rows = app.screen.query_one("#sec-table")
            assert rows.row_count == 2
            await pilot.press("escape")
            await pilot.pause(0.2)
            assert not isinstance(app.screen, mooc_tui.SectionScreen)
    _run(main)


def test_quit_key(fake):
    async def main():
        app = mooc_tui.StudyTUI()
        async with app.run_test(size=(120, 40)) as pilot:
            await pilot.pause(0.2)
            await pilot.press("q")
            await pilot.pause(0.2)
            assert app._exit is True or app.is_running is False
    _run(main)


def _qr_png(text: str) -> bytes:
    import io

    import qrcode
    from PIL import Image
    qr = qrcode.QRCode(box_size=4, border=2)
    qr.add_data(text)
    qr.make(fit=True)
    buf = io.BytesIO()
    qr.make_image(fill_color="black", back_color="white").convert("RGB").save(buf, format="PNG")
    return buf.getvalue()


def test_qr_ascii_pair_aligned():
    a, b = _qr_png("APP-CHANNEL"), _qr_png("WECHAT-CHANNEL")
    art = mooc_api_login.qr_ascii_pair(a, b, max_width=29)
    lines = art.splitlines()
    assert lines, "应有内容"
    widths = {len(line) for line in lines}
    assert len(widths) == 1, f"每行等宽才对得齐: {widths}"
    total = widths.pop()
    assert total > 3 and total % 2 == 1, "应为 左半 + 3 空格 + 右半"
    assert (total - 3) // 2 <= 29, "单张不得超过 max_width"


def test_qr_shows_both_channels_side_by_side(fake, monkeypatch):
    """Q 键同时拉两条通道，两张码并排显示（不再是先问 app/wechat）。"""
    png_a, png_b = _qr_png("APP"), _qr_png("WX")

    def fake_both(ttl=55, cycles=3, on_qr=None, **k):
        on_qr("app", 1, png_a, "uid-a")
        on_qr("wechat", 1, png_b, "uid-b")
        return {"access_token": "t"}, "default", "app"

    monkeypatch.setattr(mooc_api_login, "qr_login_both", fake_both)

    async def main():
        app = mooc_tui.StudyTUI()
        async with app.run_test(size=(120, 40)) as pilot:
            await pilot.pause(0.2)
            await pilot.press("Q")
            await pilot.pause(0.8)
            # 成功后那一屏已经关掉，验证过程改在下面单独用例（这里只验不崩）
            assert app.busy is False
            assert "APP扫码登录成功" in _log(app)
    _run(main)


def test_qr_screen_fullscreen_and_fits(fake, monkeypatch):
    """Q 键打开全屏二维码页，两张码按终端宽高自适应，不会超出屏幕。"""
    png_a, png_b = _qr_png("APP2"), _qr_png("WX2")
    hold = {}

    def fake_both(ttl=55, cycles=3, on_qr=None, **k):
        on_qr("app", 1, png_a, "ua")
        on_qr("wechat", 1, png_b, "ub")
        hold["release"].wait(5)              # 挂住，方便在成功前检查屏幕
        return {"access_token": "t"}, "default", "app"

    import threading
    hold["release"] = threading.Event()
    monkeypatch.setattr(mooc_api_login, "qr_login_both", fake_both)

    async def main():
        app = mooc_tui.StudyTUI()
        async with app.run_test(size=(100, 30)) as pilot:
            await pilot.pause(0.2)
            await pilot.press("Q")
            for _ in range(30):                     # 等两路码都到（worker 线程 + 渲染）
                if len(app._qr_pngs) == 2:
                    break
                await pilot.pause(0.1)
            scr = app._qr_screen
            assert isinstance(scr, mooc_tui.QRScreen), "应推入全屏二维码页"
            assert len(scr.pngs) == 2, scr.pngs.keys()
            lines = scr.last_art.splitlines()
            assert len(lines) >= 10, "应有二维码内容"
            assert max(len(x) for x in lines) <= 96, "不得超过终端宽度"
            assert len(lines) <= 26, "不得超过终端高度"
            # Esc 收起后后台仍在跑
            await pilot.press("escape")
            await pilot.pause(0.2)
            assert not isinstance(app.screen, mooc_tui.QRScreen)
            hold["release"].set()
            await pilot.pause(0.5)
            assert app.busy is False
    _run(main)


def test_qr_screen_narrow_terminal_shrinks(monkeypatch):
    """窄终端下二维码自动缩小（而不是被裁切）。"""
    png = _qr_png("NARROW")

    async def main():
        app = mooc_tui.StudyTUI()
        async with app.run_test(size=(60, 20)) as pilot:
            await pilot.pause(0.2)
            scr = mooc_tui.QRScreen()
            app.push_screen(scr)
            await pilot.pause(0.2)
            scr.update_pngs({"app": png})
            await pilot.pause(0.2)
            lines = scr.last_art.splitlines()
            assert lines and max(len(x) for x in lines) <= 56
            assert len(lines) <= 16
    _run(main)


def test_small_screen_columns_and_qr(fake):
    """手机窄屏：表格只留前四列，二维码改上下排列且不超屏。"""
    png_a, png_b = _qr_png("SMALL-A"), _qr_png("SMALL-B")

    async def main():
        app = mooc_tui.StudyTUI()
        async with app.run_test(size=(40, 24)) as pilot:
            await pilot.pause(0.25)
            table = app.query_one("#table")
            assert list(table.columns.keys()) == ["类型", "要求", "状态", "名称"]
            assert table.row_count == 2, "数据仍应完整渲染"
            # 二维码: 40 列下上下排列
            scr = mooc_tui.QRScreen()
            app.push_screen(scr)
            await pilot.pause(0.2)
            scr.update_pngs({"app": png_a, "wechat": png_b})
            await pilot.pause(0.3)
            lines = scr.last_art.splitlines()
            # 40x24 放不下两张（每张最少 21 模块），一次只显示一张
            assert "▶ APP 码" in scr.last_title
            assert max(len(x) for x in lines) <= 36, f"不超 40 列: {max(len(x) for x in lines)}"
            assert len(lines) <= 18, f"不超 24 行: {len(lines)}"
            # 按 2 切到微信码
            await pilot.press("2")
            await pilot.pause(0.2)
            assert "▶ 微信码" in scr.last_title
    _run(main)


def test_wide_screen_keeps_all_columns(fake):
    async def main():
        app = mooc_tui.StudyTUI()
        async with app.run_test(size=(110, 30)) as pilot:
            await pilot.pause(0.25)
            table = app.query_one("#table")
            assert list(table.columns.keys()) == [k for k, _ in mooc_tui.COLUMNS]
    _run(main)


def test_medium_screen_drops_tail_columns(fake):
    async def main():
        app = mooc_tui.StudyTUI()
        async with app.run_test(size=(70, 24)) as pilot:
            await pilot.pause(0.25)
            keys = list(app.query_one("#table").columns.keys())
            assert keys == ["类型", "要求", "状态", "名称", "推送时间"], keys
    _run(main)


def test_toolbar_click_actions(fake):
    """鼠标点击按钮栏 = 按对应快捷键。"""
    async def main():
        app = mooc_tui.StudyTUI()
        async with app.run_test(size=(120, 40)) as pilot:
            await pilot.pause(0.3)

            await pilot.click("#btn-filter")                 # 搜索
            await pilot.pause(0.2)
            assert app.query_one("#hours-input").has_class("visible")
            await pilot.press("escape")
            await pilot.pause(0.1)

            before = app.sort_mode
            await pilot.click("#btn-sort")                   # 排序
            await pilot.pause(0.2)
            assert app.sort_mode == (before + 1) % len(mooc_tui.SORT_MODES)

            await pilot.click("#btn-done")                   # 显隐已完成
            await pilot.pause(0.2)
            assert app.show_done is True

            await pilot.click("#btn-hours")                  # 补学时
            await pilot.pause(0.2)
            assert app.query_one("#hours-input").has_class("visible")
            assert app.input_mode == "hours"
    _run(main)


def test_toolbar_narrow_hides_secondary_buttons(fake):
    """40 列手机屏只留 6 个核心按钮。"""
    async def main():
        app = mooc_tui.StudyTUI()
        async with app.run_test(size=(40, 24)) as pilot:
            await pilot.pause(0.3)
            shown = [bid for bid, _l, _a, _w in mooc_tui.StudyTUI.TOOLBAR
                     if app.query_one(f"#{bid}").display]
            assert shown == ["btn-refresh", "btn-filter", "btn-study", "btn-all",
                             "btn-today", "btn-logs", "btn-hours", "btn-quit"], shown
            assert app.query_one("#btn-refresh").label.plain == "刷"   # 窄屏单字
    _run(main)


def test_toolbar_wide_shows_all(fake):
    async def main():
        app = mooc_tui.StudyTUI()
        async with app.run_test(size=(120, 40)) as pilot:
            await pilot.pause(0.3)
            shown = [bid for bid, _l, _a, _w in mooc_tui.StudyTUI.TOOLBAR
                     if app.query_one(f"#{bid}").display]
            assert len(shown) == len(mooc_tui.StudyTUI.TOOLBAR)
    _run(main)


def test_section_screen_shows_log(fake):
    """小节/视频列表页也要有运行日志，并同步主界面的新日志。"""
    async def main():
        app = mooc_tui.StudyTUI()
        async with app.run_test(size=(120, 40)) as pilot:
            await pilot.pause(0.25)
            app.query_one("#table").move_cursor(row=0)
            await pilot.pause(0.05)
            await pilot.press("enter")
            await pilot.pause(0.5)
            scr = app.screen
            assert isinstance(scr, mooc_tui.SectionScreen)
            log = scr.query_one("#sec-log")
            assert log.size.height >= 5, log.size.height     # CSS 8 行含 round 边框
            # 进入前的历史日志应回填
            text = "\n".join(str(x) for x in log.lines)
            assert "模式" in text or "刷新任务清单" in text, text[:120]
            # 主界面新日志同步到详情页
            app.log_write("小节测试日志-同步")
            await pilot.pause(0.2)
            text2 = "\n".join(str(x) for x in log.lines)
            assert "小节测试日志-同步" in text2
    _run(main)


def test_today_button_uses_quota(fake, monkeypatch):
    """「今日」按钮 = CLI --today：按 容量−已学 与 缺口 取小，再跑学时。"""
    import mooc_auto_study as mas

    monkeypatch.setattr(mooc_tui, "_today_capacity", lambda: (8.0, {"label": "标准档"}))
    monkeypatch.setattr(mooc_tui, "today_used", lambda *a, **k: 3.0)
    monkeypatch.setattr(mas, "_today_capacity", lambda: (8.0, {"label": "标准档"}))
    monkeypatch.setattr(mas, "today_used", lambda: 3.0)

    async def main():
        app = mooc_tui.StudyTUI()
        async with app.run_test(size=(120, 40)) as pilot:
            await pilot.pause(0.3)
            await pilot.click("#btn-today")
            await pilot.pause(0.6)
            bot = app.bot
            assert bot is not None
            # 容量 8 - 已学 3 = 5；缺口 50-10 = 40 → 取 5.0
            assert ("run_hours", "5.0") in bot.calls, bot.calls
            assert "目标 5.00 学时" in _log(app)
    _run(main)


def test_today_button_no_quota(fake, monkeypatch):
    async def main():
        app = mooc_tui.StudyTUI()
        monkeypatch.setattr(mooc_tui, "_today_capacity", lambda: (8.0, {"label": "标准档"}))
        monkeypatch.setattr(mooc_tui, "today_used", lambda *a, **k: 8.0)   # 已用满
        async with app.run_test(size=(120, 40)) as pilot:
            await pilot.pause(0.3)
            await pilot.click("#btn-today")
            await pilot.pause(0.4)
            assert "今天不用再学" in _log(app)
            assert app.bot is None or not any(c[0] == "run_hours" for c in app.bot.calls)
    _run(main)


def test_qr_ascii_colors_invert():
    """默认正色（白模块=亮块），i 键可切反色——反色在深色终端上常扫不出。"""
    png = _qr_png("COLOR-TEST")
    normal = mooc_api_login.qr_ascii(png)
    inverted = mooc_api_login.qr_ascii(png, invert=True)
    assert normal != inverted
    assert normal.splitlines()[0].strip(" ") != "", "正色第一行应是亮块（静区）"
    assert inverted.splitlines()[0].strip(" ") == "", "反色第一行应是空白"


def test_wechat_swap_token_failure_reports(fake, monkeypatch):
    """微信已扫码但换不到 token → 明确报错到日志/二维码页，而不是静默等到超时。"""
    def fake_both(ttl=55, cycles=3, on_qr=None, on_error=None, **k):
        on_qr("app", 1, _qr_png("A"), "ua")
        on_error("wechat", "微信已扫码，但换取凭证失败（900000）")
        raise mooc_api_login.QRLoginError("微信已扫码，但换取凭证失败")

    monkeypatch.setattr(mooc_api_login, "qr_login_both", fake_both)

    async def main():
        app = mooc_tui.StudyTUI()
        async with app.run_test(size=(100, 30)) as pilot:
            await pilot.pause(0.25)
            await pilot.press("Q")
            await pilot.pause(0.6)
            log = _log(app)
            assert "换取凭证失败" in log, log[-200:]
            assert app.busy is False
    _run(main)


def test_qr_note_clears_when_both_ready(fake, monkeypatch):
    """两张码都到齐后，「另一张码还在取」的提示必须清掉。"""
    png_a, png_b = _qr_png("N1"), _qr_png("N2")
    hold = {}

    def fake_both(ttl=55, cycles=3, on_qr=None, on_error=None, **k):
        on_qr("app", 1, png_a, "ua")
        hold["both"].wait(3)
        on_qr("wechat", 1, png_b, "ub")
        hold["both"].wait(3)
        return {"access_token": "t"}, "default", "app"

    import threading
    hold["both"] = threading.Event()
    monkeypatch.setattr(mooc_api_login, "qr_login_both", fake_both)

    async def main():
        app = mooc_tui.StudyTUI()
        async with app.run_test(size=(100, 30)) as pilot:
            await pilot.pause(0.25)
            await pilot.press("Q")
            await pilot.pause(0.5)
            scr = app._qr_screen
            assert scr is not None
            assert scr.note and "另一张码" in scr.note        # 只有一张时提示
            on_qr_hook = None
            # 放行第二个码
            hold["both"].set()
            for _ in range(30):
                if len(scr.pngs) == 2:
                    break
                await pilot.pause(0.1)
            await pilot.pause(0.2)
            assert scr.note == "", f"两码齐后旧提示没清掉: {scr.note!r}"
    _run(main)


def test_open_image_calls_system_viewer(tmp_path, monkeypatch):
    """o 键：用系统看图程序打开 PNG（Windows 用 os.startfile）。"""
    png = tmp_path / "qr.png"
    png.write_bytes(b"PNG")
    opened = []
    monkeypatch.setattr(mooc_tui.platform, "system", lambda: "Windows")
    monkeypatch.setattr(mooc_tui.os, "startfile", lambda p: opened.append(p), raising=False)
    mooc_tui.open_image(str(png))
    assert opened == [str(png)]


def test_qr_screen_open_image_key(fake, monkeypatch):
    png = _qr_png("OPEN-ME")
    opened = []
    monkeypatch.setattr(mooc_tui, "open_image", lambda p: opened.append(p))

    async def main():
        app = mooc_tui.StudyTUI()
        async with app.run_test(size=(100, 30)) as pilot:
            await pilot.pause(0.25)
            scr = mooc_tui.QRScreen()
            app.push_screen(scr)
            await pilot.pause(0.2)
            scr.update_pngs({"app": png}, paths={"app": "/tmp/mooc-qr-app.png"})
            await pilot.pause(0.2)
            await pilot.press("o")
            await pilot.pause(0.2)
            assert opened == ["/tmp/mooc-qr-app.png"], opened
    _run(main)


def test_open_image_missing_file(tmp_path):
    import pytest
    with pytest.raises(FileNotFoundError):
        mooc_tui.open_image(str(tmp_path / "nope.png"))


def test_logs_button_lists_records(fake):
    async def main():
        app = mooc_tui.StudyTUI()
        async with app.run_test(size=(120, 40)) as pilot:
            await pilot.pause(0.3)
            await pilot.click("#btn-logs")
            await pilot.pause(0.6)
            log = _log(app)
            assert "最近 7 天 2 条" in log, log[-300:]      # 0/2 两个业务类型各一条
            assert "课程0" in log and "课程2" in log
    _run(main)
