/* 图集查看器布局夹具（Muse 2026-11-19 3.2.1修复F6线）：模拟 App 壳
 * （顶栏 52px + flex-1 可用区），在可用区内挂真实 AlbumViewer，
 * 供 scripts/test-layout.mjs 验占屏比/悬浮层/翻页几何。图片经 Img
 * 走本地媒体协议，夹具环境下请求被路由拦截落占位——几何断言只看
 * 舞台与控件框，不依赖图片解码。 */
import { useState, type CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import { AlbumViewer } from "../src/features/sources/AlbumViewer";
import "../src/index.css";

/* 张数经 ?n= 注入（默认 3 与既有场景同形态；缩略图条场景传 n=146
 * 复现真机大图集——条手势隔离/快速定位/跟随同步只在大图集下成立）。 */
const params = new URLSearchParams(location.search);
/* 设备链模式（Muse 2026-11-20 fix331/gallery-device）：?real=1 时用
 * 编排脚本注入的真实图集地址（window.__DEVICE_CHAIN_URLS__，源图床
 * 实址），Img 经 cover() 指向本机真实媒体服务 127.0.0.1:17650——与
 * 几何场景的 fixture.invalid 假址＋路由拦截 fulfill 是两条完全不同
 * 的链：这里不拦截、真请求、真上游。注入缺失时回退假址（场景会因
 * 断言无图而红，不静默假绿）。 */
const realUrls = (window as unknown as { __DEVICE_CHAIN_URLS__?: string[] }).__DEVICE_CHAIN_URLS__;
const nParam = Number(params.get("n"));
const count = Number.isFinite(nParam) && nParam >= 1 ? Math.min(300, Math.floor(nParam)) : 3;
const images = params.get("real") === "1" && Array.isArray(realUrls) && realUrls.length >= 3
  ? realUrls.slice(0, count)
  : Array.from({ length: count }, (_, i) => `https://fixture.invalid/album/${i + 1}.jpg`);
/* ?immersive=1（fix330/gallery-viewer 安全区场景）：模拟 SourceGallery
 * 的 fixed 覆满视口宿主——无壳顶栏、可用区即全屏，并在根上注入已知
 * 安全区变量（--sat 47 / --sab 34，iPhone 刘海机型量级），供场景断
 * 言 chrome 让位量。默认模式（壳顶栏＋页内嵌）保持不变。 */
const immersiveMode = params.get("immersive") === "1";

function App() {
  const [index, setIndex] = useState(0);
  const [closed, setClosed] = useState(false);
  const viewer = closed
    ? <p data-ui="fixture-closed">已返回列表</p>
    : (
      <AlbumViewer title="测试相册标题" images={images} index={index}
        onIndexChange={setIndex} onBack={() => setClosed(true)} backLabel="返回相册列表"
        onClose={() => setClosed(true)} immersive={immersiveMode} />
    );
  if (immersiveMode) {
    return (
      <div data-ui="fixture-avail" style={{
        position: "fixed", inset: 0,
        "--sat": "47px", "--sab": "34px", "--sal": "0px", "--sar": "0px",
      } as CSSProperties}>
        {viewer}
      </div>
    );
  }
  return (
    <div style={{ position: "fixed", inset: 0, display: "flex", flexDirection: "column" }}>
      <div data-ui="fixture-shell-bar" style={{ height: 52, flexShrink: 0 }}>壳顶栏</div>
      <div data-ui="fixture-avail" style={{ flex: 1, position: "relative", minHeight: 0 }}>
        {viewer}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
