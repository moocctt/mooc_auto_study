# -*- coding: utf-8 -*-
"""cli 分支视觉资产：终端美学（深色 + 荧光绿 + 等宽，命令提示/日志 motif）。"""
import os
OUT = os.path.join(os.path.dirname(__file__), "..")
MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace"
BG, PANEL, FG, GREEN, DIM = "#0B0F0D", "#11171A", "#E6EDE9", "#3BD671", "#7C8C85"

def esc(t):
    return t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

def term(x, y, w, title, lines, prompt="$ "):
    """终端卡片：标题栏 + 命令行/输出行。"""
    h = 46 + len(lines) * 26 + 18
    out = [f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="12" fill="{PANEL}"/>',
           f'<rect x="{x}" y="{y}" width="{w}" height="34" rx="12" fill="#1A2024"/>',
           f'<circle cx="{x+18}" cy="{y+17}" r="5" fill="#FF5F57"/>',
           f'<circle cx="{x+36}" cy="{y+17}" r="5" fill="#FEBC2E"/>',
           f'<circle cx="{x+54}" cy="{y+17}" r="5" fill="#28C840"/>',
           f'<text x="{x+w/2}" y="{y+22}" text-anchor="middle" font-size="16" fill="{DIM}" font-family="{MONO}">{esc(title)}</text>']
    ty = y + 62
    for ln, kind in lines:
        color = {"cmd": FG, "ok": GREEN, "dim": DIM}.get(kind, FG)
        pre = prompt if kind == "cmd" else "  "
        out.append(f'<text x="{x+20}" y="{ty}" font-size="20" fill="{color}" font-family="{MONO}">{esc(pre + ln)}</text>')
        ty += 26
    out.append(f'<rect x="{x+20}" y="{ty-18}" width="10" height="20" fill="{GREEN}"/>')
    return "\n".join(out), y + h

def hero():
    body, _ = term(460, 56, 690, "mooc — 学时自动化", [
        ("mooc --list", "cmd"), ("网络自学 133.0 / 50.0  集中培训 64.0 / 90.0", "dim"),
        ("mooc --search 消防安全", "cmd"), ("[搜索] 命中 25 条（课程库，含未加入任务的）", "dim"),
        ("mooc --course \"消防安全管理\"", "cmd"), ("OK 完成，共 7 轮 / 2460s", "ok"),
    ])
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="330" viewBox="0 0 1200 330"
     role="img" aria-labelledby="t d" font-family="{MONO}">
  <title id="t">mooc-cli：终端里的学时自动化</title>
  <desc id="d">终端窗口演示：--list 看学时、--search 搜课程、--course 学完一门课。</desc>
  <rect width="1200" height="330" fill="{BG}"/>
  <g id="title-block" transform="translate(56 78)">
    <text x="0" y="0" font-size="18" fill="{GREEN}">CLI · TUI · 纯 HTTP</text>
    <text x="0" y="62" font-size="44" font-weight="800" fill="{FG}">终端里把课上完</text>
    <text x="0" y="112" font-size="20" fill="{DIM}">--list ｜ --search ｜ --course ｜ --today</text>
    <text x="0" y="152" font-size="20" fill="{FG}">不依赖浏览器，扫码用手机完成。</text>
    <text x="0" y="184" font-size="20" fill="{DIM}">学时账本、缺口、计划，都在一个命令行里。</text>
  </g>
  <g id="terminal">{body}</g>
</svg>
'''

def section(num, title, sub, accent=GREEN):
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="120" viewBox="0 0 1200 120"
     role="img" aria-labelledby="t d" font-family="{MONO}">
  <title id="t">{esc(title)}</title>
  <desc id="d">{esc(sub)}</desc>
  <rect width="1200" height="120" fill="{BG}"/>
  <rect x="0" y="118" width="1200" height="2" fill="#1A2024"/>
  <text x="56" y="52" font-size="18" fill="{accent}">{esc(num)}</text>
  <text x="56" y="94" font-size="36" font-weight="800" fill="{FG}">{esc(title)}</text>
  <text x="1180" y="66" text-anchor="end" font-size="18" fill="{DIM}">{esc(sub)}</text>
  <rect x="1100" y="90" width="10" height="20" fill="{accent}"/>
</svg>
'''

open(os.path.join(OUT, "hero.svg"), "w", encoding="utf-8").write(hero())
open(os.path.join(OUT, "section-usage.svg"), "w", encoding="utf-8").write(
    section("01", "怎么用", "--list / --search / --course / --today"))
open(os.path.join(OUT, "section-tui.svg"), "w", encoding="utf-8").write(
    section("02", "TUI：一屏管理", "mooc-tui：任务列表 · 排序 · 搜索 · 一键完成"))
open(os.path.join(OUT, "section-effect.svg"), "w", encoding="utf-8").write(
    section("03", "真实输出", "progress / quota / RESULT"))
print("generated:", sorted(f for f in os.listdir(OUT) if f.endswith(".svg")))
