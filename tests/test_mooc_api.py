"""mooc_api.py：加密自检、模板填入、二维码像素对齐、widget 自包含（全部离线）。"""
from __future__ import annotations

import io

import pytest

import mooc_api


def test_aes_fingerprint_still_matches():
    """服务端若换密钥，这个断言会先炸，比运行期神秘失败好排查。"""
    assert mooc_api.aes_encrypt("1") == mooc_api.AES_FINGERPRINT


def test_fill_template_replaces_and_blanks():
    out = mooc_api.fill_template("<p>{{A}}-{{B}}</p>", {"A": "x"})
    assert out == "<p>x-</p>", "未提供的占位符必须渲染成空串，不能留在产物里"


def test_render_qr_png_and_integer_module_size():
    from PIL import Image

    def width(size):
        png = mooc_api.render_qr("https://example.com/x", size=size)
        assert png[:8] == b"\x89PNG\r\n\x1a\n"
        w, h = Image.open(io.BytesIO(png)).size
        assert w == h
        return w

    small, big = width(160), width(320)
    # 同一个内容的模块数固定，两尺寸的边长最大公约数就是模块数；
    # 模块数只能在 {21, 25, 29, ...} 里（QR 版本 1..40），否则说明被非整数缩放过
    import math

    modules = math.gcd(small, big)
    assert modules in set(range(21, 178, 4)), f"模块数异常：{small}px / {big}px → {modules}"
    assert small <= 160 and small % modules == 0 and big % modules == 0


def test_qr_widget_is_self_contained():
    png = mooc_api.render_qr("https://example.com/x", size=160)
    html = mooc_api.render_qr_widget(png, title="扫码登录", hint="用微信扫", ttl=55)
    assert "data:image/png;base64," in html
    assert "<script" not in html.lower(), "widget 不能带 JS：宿主沙箱会卡在渲染中"
    assert "{{" not in html, "模板占位符必须全部替换"
    assert "扫码登录" in html


def test_login_widget_escapes_account():
    png = mooc_api.render_qr("https://example.com/x", size=160)
    html = mooc_api.render_login_widget(account="<b>138</b>", png=png, ttl=55)
    assert "{{" not in html
    assert "<b>138</b>" not in html, "插入的内容要转义"
    assert "&lt;b&gt;138&lt;/b&gt;" in html


def test_widget_script_wraps_with_doctype():
    html = mooc_api.widget_script("<div>hi</div>")
    assert html.lstrip().lower().startswith("<!doctype html>")
    assert "<div>hi</div>" in html


def test_login_ok_requires_access_token():
    """服务端可能把错误文本以 200 返回，只有拿到 access_token 才算登录成功。"""
    assert not mooc_api._login_ok({"raw": "系统繁忙"})
    assert not mooc_api._login_ok({})
    assert mooc_api._login_ok({"access_token": "abc"})


def test_masked_token_never_prints_full():
    assert mooc_api.mask_token("0123456789abcdef") == "0123456789..."
    assert mooc_api.mask_token("abc") == "...", "短 token 不能整颗露出"
    assert mooc_api.mask_token("") == "***"
    assert "mnop" not in mooc_api.redact_text('{"access_token":"abcd-efgh-ijkl-mnop-qrst"}')


def test_default_out_uses_data_dir():
    out = mooc_api.default_qr_out("wechat")
    assert out.endswith(".png")
    assert str(mooc_api._data_dir()) in out, "默认落在数据目录，不污染仓库根"
