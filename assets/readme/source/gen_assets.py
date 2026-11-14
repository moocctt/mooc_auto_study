# -*- coding: utf-8 -*-
"""tobacco-mooc-study README 视觉资产生成器。

视觉系统（从项目推导）：
  Palette  bg #F4F8F5 / panel #0F2419 / primary #1F6F4A / accent #E8A13A / muted #6B7A73
  Type     PingFang SC,system-ui；display 44 / section 36 / body 20 / mono 18
  Shape    圆角 16-20，细线 1.5，间距 24
  Motif    学时进度条（圆角细条+数字）+ 对话气泡
  Density  editorial（留白多，真实输出为主）
"""
import os

FONT = "PingFang SC,Microsoft YaHei,system-ui,sans-serif"
MONO = "Menlo,Consolas,ui-monospace,monospace"
BG, PANEL, PRIMARY, ACCENT, MUTED = "#F4F8F5", "#0F2419", "#1F6F4A", "#E8A13A", "#6B7A73"
LINE, WHITE, GREEN_TEXT = "#DCE6E0", "#FFFFFF", "#DCEFE2"
OUT = os.path.join(os.path.dirname(__file__), "..")

def esc(t):
    return t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

def progress(x, y, w, label, done, total, tone=PRIMARY):
    """motif：学时进度条。返回 svg 片段。"""
    rate = min(1.6, done / max(total, 1))
    bar = w - 150
    fill_w = min(bar, int(bar * min(rate, 1.0)))
    over = fill_w >= bar and rate > 1.0
    color = PRIMARY if rate <= 1.0 else "#B8860B"
    return f'''  <text x="{x}" y="{y}" font-size="20" fill="#16241c" font-family="{FONT}">{esc(label)}</text>
  <text x="{x+w}" y="{y}" text-anchor="end" font-size="20" fill="{MUTED}" font-family="{MONO}">{done:g} / {total:g} 学时</text>
  <rect x="{x}" y="{y+12}" width="{bar}" height="10" rx="5" fill="#E3EBE5"/>
  <rect x="{x}" y="{y+12}" width="{fill_w}" height="10" rx="5" fill="{color}"/>
  <text x="{x}" y="{y+46}" font-size="18" fill="{MUTED}" font-family="{FONT}">{esc(("超额 %.0f%%" % ((rate-1)*100)) if over else ("完成率 %.0f%%" % (rate*100)))}</text>'''

def bubble(x, y, w, lines, me=False, mono=False):
    """对话气泡（右=用户 绿底白字；左=助手 白底深字）。"""
    fill = PRIMARY if me else WHITE
    fg = WHITE if me else "#16241c"
    h = 22 * len(lines) + 30
    stroke = "" if me else f' stroke="{LINE}"'
    out = [f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="16" fill="{fill}"{stroke}/>']
    ty = y + 34
    for ln in lines:
        out.append(f'<text x="{x+20}" y="{ty}" font-size="20" fill="{fg}" font-family="{FONT}">{esc(ln)}</text>')
        ty += 22
    return "\n".join(out), y + h

def chat_card(x, y, w, title, bubbles, h):
    """深色对话卡片（手机风格）。"""
    out = [f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="20" fill="{PANEL}"/>',
           f'<text x="{x+24}" y="{y+38}" font-size="18" fill="{GREEN_TEXT}" font-family="{FONT}">{esc(title)}</text>',
           f'<text x="{x+w-24}" y="{y+38}" text-anchor="end" font-size="18" fill="#7BA893" font-family="{FONT}">已连接</text>',
           f'<line x1="{x}" y1="{y+54}" x2="{x+w}" y2="{y+54}" stroke="#1E3A2C"/>']
    cy = y + 74
    for who, lines in bubbles:
        bw = w - 48
        if who == "user":
            b, bh = bubble(x + 40, cy, bw, lines, me=True)
        else:
            b, bh = bubble(x + 8, cy, bw, lines, me=False)
        out.append(b)
        cy += bh + 14
    return "\n".join(out), cy


def gen_hero():
    title, desc = "tobacco-mooc-study 主视觉", "用中文对 AI 助手说需求，即可管理烟草网络学院的学时、计划与课程学习"
    h = 372
    parts = [f'''<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="{h}" viewBox="0 0 1200 {h}"
     role="img" aria-labelledby="t d" font-family="{FONT}">
  <title id="t">{esc(title)}</title>
  <desc id="d">{esc(desc)}</desc>
  <rect width="1200" height="{h}" fill="{BG}"/>
  <g id="title-block" transform="translate(56 54)">
    <text x="0" y="0" font-size="18" fill="{ACCENT}" font-family="{MONO}" letter-spacing="3">AI SKILL · 烟草网络学院</text>
    <text x="0" y="62" font-size="44" font-weight="800" fill="#16241c">跟 AI 助手说人话，</text>
    <text x="0" y="114" font-size="44" font-weight="800" fill="#16241c">管好烟草网络学院</text>
    <text x="0" y="162" font-size="20" fill="{MUTED}">看学时 · 排计划 · 把课学完 · 截止日进手机日历</text>
    <text x="0" y="212" font-size="20" fill="#16241c" font-weight="600">你只说想要什么，剩下的它来判断。</text>
    <text x="0" y="244" font-size="20" fill="{MUTED}">网课学时再多，也补不上面授缺口——它会替你把账分开算。</text>
  </g>
  <g id="chat-proof" transform="translate(700 46)">''']
    body, cy = chat_card(0, 0, 444, "学时助手 · 已连接", [
        ("user", ["帮我看看到底还差多少学时"]),
        ("ai", ["网络自学  128 / 50 · 已达标", "集中培训   64 / 90 · 还差 26", "网课补不了面授那 26 学时。"]),
    ], 262)
    parts.append(body)
    parts.append('</g>')
    parts.append(f'  <g id="ledger-motif" transform="translate(56 {h-58})">')
    parts.append(progress(0, 18, 520, "网络自学", 128, 50))
    parts.append(progress(600, 18, 520, "集中培训", 64, 90, tone=ACCENT))
    parts.append('</g>')
    parts.append('</svg>')
    return "\n".join(parts) + "\n"


def gen_section(num, title, sub):
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="120" viewBox="0 0 1200 120"
     role="img" aria-labelledby="t d" font-family="{FONT}">
  <title id="t">{esc(title)}</title>
  <desc id="d">{esc(sub)}</desc>
  <rect width="1200" height="120" fill="{WHITE}"/>
  <rect x="0" y="118" width="1200" height="2" fill="{BG}"/>
  <text x="56" y="52" font-size="18" fill="{ACCENT}" font-family="{MONO}">{esc(num)}</text>
  <text x="56" y="94" font-size="36" font-weight="800" fill="#16241c">{esc(title)}</text>
  <text x="56" y="120" font-size="20" fill="{MUTED}" opacity="0"/>
  <text x="1180" y="66" text-anchor="end" font-size="20" fill="{MUTED}">{esc(sub)}</text>
  <circle cx="1140" cy="94" r="6" fill="{ACCENT}"/>
  <circle cx="1156" cy="94" r="6" fill="{PRIMARY}" opacity="0.55"/>
  <circle cx="1172" cy="94" r="6" fill="#C9D8CE"/>
</svg>'''


def gen_chat(fname, title, bubbles, h):
    parts = [f'''<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="{h}" viewBox="0 0 1200 {h}"
     role="img" aria-labelledby="t d" font-family="{FONT}">
  <title id="t">{esc(title)}</title>
  <desc id="d">与 AI 助手的真实对话截图（输出来自平台实测）。</desc>
  <rect width="1200" height="{h}" fill="{BG}"/>
  <rect x="170" y="24" width="860" height="{h-48}" rx="20" fill="{PANEL}"/>''']
    body, cy = chat_card(194, 48, 812, title, bubbles, h - 72)
    parts.append(body)
    parts.append('</svg>')
    return "\n".join(parts) + "\n"


OUTDIR = OUT
open(os.path.join(OUTDIR, "hero.svg"), "w", encoding="utf-8").write(gen_hero())
open(os.path.join(OUTDIR, "section-1-effect.svg"), "w", encoding="utf-8").write(
    gen_section("01", "你说话，它干活", "每个例子都是真实输出"))
open(os.path.join(OUTDIR, "section-2-install.svg"), "w", encoding="utf-8").write(
    gen_section("02", "一条命令装好", "npx skills add gandli/tobacco-mooc-study -g"))
open(os.path.join(OUTDIR, "section-3-pitfalls.svg"), "w", encoding="utf-8").write(
    gen_section("03", "它会替你留意的坑", "登录态 · 学时口径 · 异步汇总 · 单端会话"))
open(os.path.join(OUTDIR, "section-4-risk.svg"), "w", encoding="utf-8").write(
    gen_section("04", "先说清楚风险", "平台禁止刷课，账号风险自负，考试必须本人"))
open(os.path.join(OUTDIR, "chat-hours.svg"), "w", encoding="utf-8").write(gen_chat(
    "chat-hours", "学时与缺口", [
        ("user", ["帮我看看到底还差多少学时"]),
        ("ai", ["网络自学  128 / 50 · 已达标", "集中培训   64 / 90 · 还差 26 学时", "网课学再多，也补不上面授那 26 学时。"]),
    ], 300))
open(os.path.join(OUTDIR, "chat-study.svg"), "w", encoding="utf-8").write(gen_chat(
    "chat-study", "把《内部控制及风险管理》学完", [
        ("user", ["把《内部控制及风险管理》帮我学完"]),
        ("ai", ["体检：共 2 节，合计约 77 分钟。确认后我开始。"]),
        ("user", ["嗯，开始吧"]),
        ("ai", ["学完了，2/2 节：", "（一）OK 1 轮 / 445s", "（二）OK 7 轮 / 4200s", "平台更新完成状态要几分钟，不用重跑。"]),
    ], 420))
open(os.path.join(OUTDIR, "chat-calendar.svg"), "w", encoding="utf-8").write(gen_chat(
    "chat-calendar", "必修截止日进日历", [
        ("user", ["必修课的截止日期提醒我"]),
        ("ai", ["已生成 1 条必修截止日（课程名已脱敏）：", "gandli.github.io/mooc-calendar/mooc-gandli.ics", "【截止】必修 · 必修任务 #1（还差 56 天）", "手机日历添加订阅即可，提前 3 天提醒。"]),
    ], 320))
print("generated:", sorted(os.listdir(OUTDIR)))
