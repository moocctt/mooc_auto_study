#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
极简 WebSocket 客户端 (RFC 6455) —— 零依赖
==========================================
只为知学云 MOOC 的课程学习心跳通道服务, 够用即可:
  - TLS 握手 + Upgrade 握手
  - 文本帧发送 (客户端强制掩码)
  - 接收文本/二进制/控制帧, 自动回 PONG
  - 断线由上层负责重连

服务端: wss://mooc.ctt.cn/api/v1/course-study/ws/course?token=<access_token>
协议:   客户端每 10s 发一次文本 "PING" (源自 module-study 的 4160 模块)
        服务端会下发 "PANG"(忽略) / "timeExpand_<秒>" / "otherClientStudy" /
        "multipleClientStudy" 等指令
"""

import base64
import os
import socket
import ssl
import struct
import time
from urllib.parse import urlparse

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


class WSClosed(Exception):
    pass


class WSClient:
    def __init__(self, url, headers=None, timeout=15):
        self.url = url
        self.extra_headers = headers or {}
        self.timeout = timeout
        self.sock = None
        self.buf = b""
        self._connect()

    # ------------------------------------------------------------ 握手
    def _connect(self):
        u = urlparse(self.url)
        host = u.hostname
        port = u.port or (443 if u.scheme == "wss" else 80)
        path = u.path or "/"
        if u.query:
            path += "?" + u.query

        raw = socket.create_connection((host, port), timeout=self.timeout)
        if u.scheme == "wss":
            ctx = ssl.create_default_context()
            raw = ctx.wrap_socket(raw, server_hostname=host)
        raw.settimeout(self.timeout)
        self.sock = raw

        key = base64.b64encode(os.urandom(16)).decode()
        lines = [
            f"GET {path} HTTP/1.1",
            f"Host: {host}",
            "Upgrade: websocket",
            "Connection: Upgrade",
            f"Sec-WebSocket-Key: {key}",
            "Sec-WebSocket-Version: 13",
            "Origin: https://mooc.ctt.cn",
            "User-Agent: Mozilla/5.0 (Linux; Android 15; BSN-AN00) Mobile",
        ]
        for k, v in self.extra_headers.items():
            lines.append(f"{k}: {v}")
        raw.sendall(("\r\n".join(lines) + "\r\n\r\n").encode())

        # 读响应头
        head = b""
        while b"\r\n\r\n" not in head:
            chunk = raw.recv(4096)
            if not chunk:
                raise WSClosed("握手期间连接被关闭")
            head += chunk
        header, _, rest = head.partition(b"\r\n\r\n")
        first = header.split(b"\r\n")[0].decode("latin1")
        if "101" not in first:
            raise WSClosed(f"WebSocket 升级失败: {first}")
        self.buf = rest

    # ------------------------------------------------------------ 帧编解码
    def _send_frame(self, payload: bytes, opcode=0x1):
        mask = os.urandom(4)
        n = len(payload)
        if n < 126:
            header = struct.pack("!BB", 0x80 | opcode, 0x80 | n)
        elif n < 65536:
            header = struct.pack("!BBH", 0x80 | opcode, 0x80 | 126, n)
        else:
            header = struct.pack("!BBQ", 0x80 | opcode, 0x80 | 127, n)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(header + mask + masked)

    def send(self, text: str):
        self._send_frame(text.encode("utf-8"))

    def _recv_exact(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise WSClosed("连接被关闭")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def recv(self):
        """返回 (opcode, payload bytes); 遇到 PING 自动回 PONG 后继续读。"""
        while True:
            b1, b2 = self._recv_exact(2)
            opcode = b1 & 0x0F
            masked = b2 & 0x80
            n = b2 & 0x7F
            if n == 126:
                n = struct.unpack("!H", self._recv_exact(2))[0]
            elif n == 127:
                n = struct.unpack("!Q", self._recv_exact(8))[0]
            mask = self._recv_exact(4) if masked else None
            data = self._recv_exact(n) if n else b""
            if mask:
                data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
            if opcode == 0x9:           # PING → PONG
                self._send_frame(data, 0xA)
                continue
            if opcode == 0xA:           # PONG
                continue
            if opcode == 0x8:           # CLOSE
                raise WSClosed("服务端主动关闭")
            return opcode, data

    def recv_text(self, timeout=None):
        if timeout is not None:
            self.sock.settimeout(timeout)
        op, data = self.recv()
        return data.decode("utf-8", "replace")

    def close(self):
        try:
            if self.sock:
                self._send_frame(b"", 0x8)
        except Exception:
            pass
        try:
            if self.sock:
                self.sock.close()
        except Exception:
            pass
        self.sock = None


if __name__ == "__main__":
    import json
    import sys

    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from mooc_client import fresh_token

    tok = fresh_token()
    url = ("wss://mooc.ctt.cn/api/v1/course-study/ws/course?token="
           + tok["access_token"])
    ws = WSClient(url)
    print("[WS] 已连接")
    ws.send("PING")
    print("[WS] 已发送 PING")
    t0 = time.time()
    try:
        while time.time() - t0 < 12:
            msg = ws.recv_text(timeout=5)
            print(f"[WS] 收到 {msg!r}")
            if msg != "PANG":
                ws.send("PING")
    except Exception as e:
        print("[WS] 结束:", type(e).__name__, e)
    finally:
        ws.close()
