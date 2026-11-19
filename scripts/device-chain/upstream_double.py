#!/usr/bin/env python3
"""设备链模拟的上游替身（Muse 2026-11-20 fix331/gallery-device）。

为什么需要替身：本机沙箱出口对一切 TLS 做中间人重签（自有 CA 只在
系统信任库里），而 App 生产抓取栈用 webpki-roots 校验证书——沙箱内
从 Rust 栈出发的任何真实 HTTPS 都必然 UnknownIssuer（环境伪影，
真机诊断已证明该栈 TLS 在设备上正常）。故上游腿用本地替身回放
**实测过的** source-006 图床策略，字节用真实图片（编排脚本经 curl
预先抓取的原图），协议降为 HTTP；被测变量（Referer 形态×扩展名×
状态码）与实测矩阵逐项一致：
- 无 Referer → 200（全扩展名）
- 本站 Referer → 200
- 外站 Referer → .jpg 403、.webp 200（豁免）
日志只记扩展名/Referer 类别（none/self/foreign）/状态，不记完整 URL。
用法：DOUBLE_PORT=19090 DOUBLE_MANIFEST=/tmp/dc-manifest.json python3 upstream_double.py
manifest 格式：{"/wp-content/.../x.jpg": "/abs/cache/file.jpg", ...}
注：替身地址不能用 127.0.0.1——生产 SSRF 策略（network_policy）在
/img 入口就拒绝回环/内网目标（应用不变量，不为模拟放宽）。策略明文
放行 FakeIP 段 198.18.0.0/15，编排脚本把替身挂在 198.18.0.7 上
（lo 别名地址），与真机上「代理 FakeIP 形态」恰好同构。
"""
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

PORT = int(os.environ.get("DOUBLE_PORT", "19090"))
HOST = os.environ.get("DOUBLE_HOST", "127.0.0.1")
MANIFEST = json.load(open(os.environ["DOUBLE_MANIFEST"], encoding="utf8"))


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):  # 静默默认日志，走 do_GET 的分类日志
        pass

    def do_GET(self):
        path = urlparse(self.path).path
        referer = self.headers.get("Referer")
        host_hdr = self.headers.get("Host", "")
        if referer is None:
            ref_class = "none"
        elif host_hdr and host_hdr in referer:
            ref_class = "self"
        else:
            ref_class = "foreign"
        ext = os.path.splitext(path)[1].lower()
        status = 200
        if ref_class == "foreign" and ext == ".jpg":
            status = 403  # 实测：外站 Referer 对受保护 jpg 回 403
        target = MANIFEST.get(path)
        if target is None:
            status = 404
        import time as _t
        print(f"[double] {_t.strftime('%H:%M:%S')}.{_t.time_ns() // 1_000_000 % 1000:03d} GET ext={ext or '-'} referer={ref_class} -> {status}", flush=True)
        if status != 200:
            body = b""
            self.send_response(status)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        with open(target, "rb") as fh:
            body = fh.read()
        self.send_response(200)
        self.send_header("Content-Type", "image/webp" if ext == ".webp" else "image/jpeg")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    print(f"[double] listening {HOST}:{PORT} entries={len(MANIFEST)}", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
