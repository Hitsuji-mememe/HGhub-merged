#!/usr/bin/env bash
# 设备链模拟编排（Muse 2026-11-20 fix331/gallery-device，用户 01:06
# 验收门槛：修复证据必须走完整设备链——真实本地 /img 路由＋代理量
# 级延迟注入＋真实并发，不许只在组件级/直连快网下自称已修）。
#
# 链路构成：
#   浏览器腿：Playwright(Chromium) 夹具页 AlbumViewer
#     → Img/cover() → http://127.0.0.1:17650/img（生产 linux_http）
#     → media::handle → 生产抓取栈（net::edge/client，含 Referer 候选链）
#     → HGHUBX_PROXY 节流代理（延迟/限速/并发上限，throttle_proxy.py）
#     → 上游替身（upstream_double.py：回放实测的图床防盗链策略，
#        字节为经 curl 预抓的真实原图）
#   路由腿：同一服务进程内由 Rust 测试直接以 17 并发（设备诊断在途
#     峰值量级）请求 /img 并断言状态与字节量级。
#
# 为什么上游是替身而非真实图床：本机沙箱出口对一切 TLS 中间人重签
# （自有 CA 只在系统信任库），App 抓取栈用 webpki-roots 校验，沙箱
# 内任何真实 HTTPS 必然 UnknownIssuer——环境伪影（真机诊断证明该
# 栈在设备上 TLS 正常）。替身回放的策略矩阵（无/本/外站 Referer ×
# jpg/webp 的状态码）为本线同日 curl 实测原样，字节为真实原图；残余
# 差异（上游 TLS 与服务器实现本身）记于报告设备链一节。
#
# 用法：bash scripts/device-chain/run-device-chain.sh
# 可调：THROTTLE_CONNECT_DELAY_MS / THROTTLE_KBPS / THROTTLE_MAX_TUNNELS
#       SKIP_BROWSER=1 只跑路由腿；DEVICE_CHAIN_WORK 资产目录。
set -uo pipefail
cd "$(dirname "$0")/../.."
export PATH="$HOME/.cargo/bin:$PATH"
# CARGO_TARGET_DIR 仅在调用方显式给出时透传（默认用仓内 src-tauri/target，
# 避免换目录触发全量重编）。
[ -n "${CARGO_TARGET_DIR:-}" ] && export CARGO_TARGET_DIR
# DEVLIBS_ROOT：Tauri 桌面 dev 库（gtk/webkit 的 .so 链接符号与 .pc）
# 未系统安装时，给出 dpkg -x 解包根，脚本据此设 pkg-config 与链接路径。
if [ -n "${DEVLIBS_ROOT:-}" ]; then
  export PKG_CONFIG_SYSROOT_DIR="$DEVLIBS_ROOT"
  export PKG_CONFIG_PATH="$DEVLIBS_ROOT/usr/lib/x86_64-linux-gnu/pkgconfig:$DEVLIBS_ROOT/usr/share/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
  export LIBRARY_PATH="$DEVLIBS_ROOT/usr/lib/x86_64-linux-gnu${LIBRARY_PATH:+:$LIBRARY_PATH}"
fi
export CARGO_TERM_COLOR=never
TPORT="${THROTTLE_PORT:-17890}"
DPORT="${DOUBLE_PORT:-19090}"
# 替身必须挂在生产 SSRF 策略放行的 FakeIP 段（127.0.0.1 会被 /img
# 入口的目标校验直接拒绝——那是应用不变量，不为模拟放宽）。
DHOST="${DOUBLE_HOST:-198.18.0.7}"
WORK="${DEVICE_CHAIN_WORK:-/tmp/device-chain}"
URLS_FILE="$WORK/urls-double.json"
SRV_PID=""
mkdir -p "$WORK/cache"

cleanup() {
  [ -n "$SRV_PID" ] && kill "$SRV_PID" 2>/dev/null
  pkill -f "throttle_proxy.py" 2>/dev/null
  pkill -f "upstream_double.py" 2>/dev/null
  pkill -f "device_chain_img_route" 2>/dev/null
  true
}
trap cleanup EXIT

UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
echo "== [0/4] 实时取 source-006 图集（wp-json 首个 ≥100 张 jpg 的帖）＋预抓原图字节 =="
curl -s -m 60 "https://xiuren.biz/wp-json/wp/v2/posts?page=1&per_page=10&_fields=content" -A "$UA" \
  | python3 -c "
import json, re, sys
posts = json.load(sys.stdin)
for p in posts:
    srcs = re.findall(r'<img[^>]+src=\"([^\"]+)\"', p['content']['rendered'])
    if len([s for s in srcs if s.endswith('.jpg')]) >= 100:
        json.dump(srcs, open('$WORK/urls-real.json', 'w'))
        print(f'urls: {len(srcs)}')
        break
else:
    sys.exit('no post with >=100 jpg images found')
" || exit 1
python3 - "$WORK" "$DHOST" "$DPORT" <<'PYEOF'
import json, os, sys
from urllib.parse import urlparse
work, dhost, dport = sys.argv[1], sys.argv[2], sys.argv[3]
urls = json.load(open(f"{work}/urls-real.json"))
manifest, double_urls = {}, []
for i, u in enumerate(urls):
    path = urlparse(u).path
    local = os.path.join(work, "cache", f"{i:03d}" + os.path.splitext(path)[1])
    manifest[path] = local
    double_urls.append(f"http://{dhost}:{dport}{path}")
json.dump(manifest, open(f"{work}/manifest.json", "w"))
json.dump(double_urls, open(f"{work}/urls-double.json", "w"))
with open(f"{work}/download.list", "w") as fh:
    for u, local in zip(urls, manifest.values()):
        fh.write(f"{u}\t{local}\n")
print(f"manifest: {len(manifest)} entries")
PYEOF
while IFS=$'\t' read -r u local; do
  [ -s "$local" ] || curl -s -m 60 -A "$UA" -o "$local" "$u" &
  while [ "$(jobs -r | wc -l)" -ge 8 ]; do wait -n; done
done < "$WORK/download.list"
wait
echo "原图缓存：$(ls "$WORK/cache" | wc -l) 个文件，$(du -sh "$WORK/cache" | cut -f1)"

echo "== [1/4] 起上游替身 127.0.0.1:$DPORT（对外形态 $DHOST:$DPORT）与节流代理 127.0.0.1:$TPORT =="
# 替身实际监听回环、由节流代理把 $DHOST:$DPORT 的连接落点改写过来
# （沙箱无 NET_ADMIN 挂不了 lo 别名；被测栈看到的目标仍是 FakeIP 形态，
# 请求行/Host 头不改，见 throttle_proxy.py THROTTLE_REWRITE 注）。
DOUBLE_PORT=$DPORT DOUBLE_MANIFEST="$WORK/manifest.json" python3 scripts/device-chain/upstream_double.py > "$WORK/double.log" 2>&1 &
THROTTLE_REWRITE="$DHOST:$DPORT>127.0.0.1:$DPORT" THROTTLE_PORT=$TPORT python3 scripts/device-chain/throttle_proxy.py > "$WORK/throttle.log" 2>&1 &
sleep 1

echo "== [2/4] 路由腿：真实 /img 服务＋生产抓取栈（单张 jpg＋17 并发断言，节流 delay=${THROTTLE_CONNECT_DELAY_MS:-250}ms kbps=${THROTTLE_KBPS:-256}） =="
HGHUBX_PROXY="http://127.0.0.1:$TPORT" DEVICE_CHAIN_URLS_FILE="$URLS_FILE" timeout 900 \
  cargo test --manifest-path src-tauri/Cargo.toml --lib device_chain_img_route -- --ignored --nocapture --test-threads=1 \
  || { echo "路由腿失败"; exit 1; }

if [ "${SKIP_BROWSER:-0}" != "1" ]; then
  echo "== [3/4] 浏览器腿：SERVE 模式起服务，Playwright 夹具真链断言 =="
  HGHUBX_PROXY="http://127.0.0.1:$TPORT" DEVICE_CHAIN_SERVE=1 DEVICE_CHAIN_URLS_FILE="$URLS_FILE" \
    cargo test --manifest-path src-tauri/Cargo.toml --lib device_chain_img_route -- --ignored --nocapture --test-threads=1 > "$WORK/serve.log" 2>&1 &
  SRV_PID=$!
  for i in $(seq 1 90); do
    (echo > /dev/tcp/127.0.0.1/17650) >/dev/null 2>&1 && break
    sleep 2
  done
  DEVICE_CHAIN=1 DEVICE_CHAIN_URLS="$URLS_FILE" LAYOUT_ONLY=gallery node scripts/test-layout.mjs || { echo "浏览器腿失败"; exit 1; }
fi
echo "== [4/4] 替身请求分类日志（节选） =="
grep -c "referer=foreign -> 403" "$WORK/double.log" 2>/dev/null | sed 's/^/foreign-403 次数: /' || true
grep -c "-> 200" "$WORK/double.log" 2>/dev/null | sed 's/^/200 次数: /' || true
echo "== 设备链全腿通过 =="
