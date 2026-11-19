#!/usr/bin/env python3
"""设备链模拟的节流代理（Muse 2026-11-20 fix331/gallery-device）。

盲 CONNECT 隧道，模拟用户代理线路量级的传输条件——这是设备链里
本机直连与真机最大的差异面，必须显式建模而不是默认快网：
- THROTTLE_CONNECT_DELAY_MS：每条隧道建立前的人工延迟（默认 250）。
- THROTTLE_KBPS：每条隧道的字节滴速上限（默认 256 KB/s，双向同速）。
- THROTTLE_MAX_TUNNELS：并发隧道上限（默认 0=不限）；超限的新隧道
  立即关闭（模拟线路/上游并发受限时的传输层重置——设备诊断里
  Feed 封面 22% network 类终局失败的候选形态之一）。
- THROTTLE_UPSTREAM：上游 HTTP 代理（http://[user:pass@]host:port）。
  本机沙箱直连外网会被拦截、必须经其出口代理时用它链式 CONNECT；
  凭据只经环境变量传入，不写进仓库与日志。真机上等价位置就是用户
  自己的代理线路——本代理建模的是「线路条件」而非某一跳的具体实现。
只记计数（接受/拒绝/完成），不记目标与内容。
用法：THROTTLE_PORT=17890 python3 throttle_proxy.py
"""
import base64
import os
import socket
import threading
import time
from urllib.parse import urlparse

PORT = int(os.environ.get("THROTTLE_PORT", "17890"))
CONNECT_DELAY_MS = int(os.environ.get("THROTTLE_CONNECT_DELAY_MS", "250"))
KBPS = int(os.environ.get("THROTTLE_KBPS", "256"))
MAX_TUNNELS = int(os.environ.get("THROTTLE_MAX_TUNNELS", "0"))
UPSTREAM = os.environ.get("THROTTLE_UPSTREAM", "")
# THROTTLE_REWRITE="198.18.0.7:19090>127.0.0.1:19090"：明文 HTTP 转发
# 时的目标改写（逗号分隔多条）。沙箱无 NET_ADMIN、无法把 FakeIP 别名
# 地址挂到 lo 时用它把替身目标落到本地监听——只改实际连接落点，
# 请求行与 Host 头保持原样，被测栈看到的目标形态不变。
REWRITES = {}
for _item in os.environ.get("THROTTLE_REWRITE", "").split(","):
    if ">" in _item:
        _src, _dst = _item.split(">", 1)
        _sh, _, _sp = _src.rpartition(":")
        _dh, _, _dp = _dst.rpartition(":")
        REWRITES[(_sh, int(_sp or "80"))] = (_dh, int(_dp or "80"))


def open_upstream(host, port):
    """直连目标，或经 THROTTLE_UPSTREAM 链式 CONNECT。"""
    if not UPSTREAM:
        return socket.create_connection((host, port), timeout=30)
    u = urlparse(UPSTREAM)
    up = socket.create_connection((u.hostname, u.port or 3128), timeout=30)
    lines = [f"CONNECT {host}:{port} HTTP/1.1", f"Host: {host}:{port}"]
    if u.username:
        cred = base64.b64encode(f"{u.username}:{u.password or ''}".encode()).decode()
        lines.append(f"Proxy-Authorization: Basic {cred}")
    up.sendall(("\r\n".join(lines) + "\r\n\r\n").encode())
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = up.recv(4096)
        if not chunk:
            up.close()
            raise OSError("upstream closed during CONNECT")
        buf += chunk
    if b" 200 " not in buf.split(b"\r\n", 1)[0]:
        up.close()
        raise OSError("upstream CONNECT refused")
    return up

lock = threading.Lock()
stats = {"accepted": 0, "rejected": 0, "finished": 0, "active": 0}


def log(msg):
    print(f"[throttle] {msg}", flush=True)


def pump(src, dst, pace):
    try:
        while True:
            data = src.recv(65536)
            if not data:
                break
            if pace:
                # 滴速：按字节数折算睡眠，粗粒度即可（模拟量级而非精确整形）
                time.sleep(len(data) / pace)
            dst.sendall(data)
    except OSError:
        pass
    finally:
        try:
            dst.shutdown(socket.SHUT_WR)
        except OSError:
            pass


def handle_plain_http(client, first_buf):
    """明文 HTTP 代理请求（绝对 URI 形态）：设备链里上游替身走 HTTP
    时 reqwest 以此形态经代理取页，同样施加延迟/限速/并发上限。
    并发计数由调用方 handle() 的槽位负责，本函数不另计。"""
    try:
        head, _, rest = first_buf.partition(b"\r\n\r\n")
        lines = head.split(b"\r\n")
        method, target, version = lines[0].decode("latin1").split(" ", 2)
        u = urlparse(target)
        host, port = u.hostname, u.port or 80
        host, port = REWRITES.get((host, port), (host, port))
        path = u.path or "/"
        if u.query:
            path += "?" + u.query
        if CONNECT_DELAY_MS:
            time.sleep(CONNECT_DELAY_MS / 1000.0)
        upstream = socket.create_connection((host, port), timeout=30)
        with lock:
            stats["accepted"] += 1
        fwd = [f"{method} {path} {version}".encode()]
        for raw in lines[1:]:
            low = raw.lower()
            if low.startswith(b"proxy-connection:") or low.startswith(b"connection:"):
                continue
            fwd.append(raw)
        # 代理↔替身这一跳逐请求关闭：本处理器一条连接只处理一个请求，
        # 若保持长连接，客户端（reqwest 连接池）复用该连接发下一请求
        # 时无人读取、必等 20s 超时才换连接（实测 403→下一候选间隔
        # 20.6s 即此形态）。Connection: close 让响应后立即 EOF 回收。
        fwd.append(b"Connection: close")
        upstream.sendall(b"\r\n".join(fwd) + b"\r\n\r\n" + rest)
        pace = KBPS * 1024 if KBPS > 0 else 0
        t = threading.Thread(target=pump, args=(upstream, client, pace), daemon=True)
        t.start()
        # 请求体通常为空（GET）；单向回放响应即可
        t.join(timeout=60)
        upstream.close()
        client.close()
        with lock:
            stats["finished"] += 1
    except OSError:
        try:
            client.close()
        except OSError:
            pass


def handle(client):
    with lock:
        stats["active"] += 1
        active = stats["active"]
    try:
        if MAX_TUNNELS and active > MAX_TUNNELS:
            with lock:
                stats["rejected"] += 1
            client.close()
            return
        client.settimeout(30)
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = client.recv(4096)
            if not chunk:
                client.close()
                return
            buf += chunk
        line = buf.split(b"\r\n", 1)[0].decode("latin1")
        parts = line.split(" ")
        if len(parts) < 2:
            client.close()
            return
        if parts[0].upper() != "CONNECT":
            # 明文 HTTP 代理请求：转交专门处理（沿用本连接的并发槽位，
            # 本函数 finally 统一归还）
            handle_plain_http(client, buf)
            return
        hostport = parts[1]
        host, _, port = hostport.rpartition(":")
        if CONNECT_DELAY_MS:
            time.sleep(CONNECT_DELAY_MS / 1000.0)
        upstream = open_upstream(host, int(port or "443"))
        with lock:
            stats["accepted"] += 1
        client.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        pace = KBPS * 1024 if KBPS > 0 else 0
        t1 = threading.Thread(target=pump, args=(client, upstream, pace), daemon=True)
        t2 = threading.Thread(target=pump, args=(upstream, client, pace), daemon=True)
        t1.start()
        t2.start()
        t1.join()
        t2.join()
        upstream.close()
        client.close()
        with lock:
            stats["finished"] += 1
    except OSError:
        try:
            client.close()
        except OSError:
            pass
    finally:
        with lock:
            stats["active"] -= 1


def main():
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", PORT))
    srv.listen(64)
    log(f"listening 127.0.0.1:{PORT} delay={CONNECT_DELAY_MS}ms kbps={KBPS} max_tunnels={MAX_TUNNELS or 'unlimited'}")
    while True:
        client, _ = srv.accept()
        threading.Thread(target=handle, args=(client,), daemon=True).start()


if __name__ == "__main__":
    main()
