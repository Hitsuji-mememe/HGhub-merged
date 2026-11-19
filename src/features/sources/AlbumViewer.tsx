/**
 * 全屏图集查看器（Muse 2026-11-19 3.2.1修复F6线，用户实报图集图片
 * 太小后定版的主流形态，SourceGallery 与搜索图片详情共用）：
 * - 舞台即全区：根容器由调用方给满可用高度（SourceGallery 用 fixed
 *   inset-0 覆满视口、Search 用详情页内 h-full），图片 fit="contain"
 *   贴边铺满，不再有写死比例盒子、没有上下张大按钮行。
 * - 悬浮层（chrome）：标题/计数/返回/关闭在顶部、缩略图条在底部，
 *   全部只在悬浮层呼出时在场；静止 ALBUM_CHROME_IDLE_MS 后自动淡出。
 * - 点按消歧：中央 1/3 点按只切悬浮层显隐，左右各 1/3 点按翻页；
 *   横滑（|dx|≥48 且横向主导）翻页为主手势。悬浮层自身控件点按
 *   stopPropagation，不穿透到舞台手势。
 * - 手势归属（Muse 2026-11-19 fix322/gallery 线，用户实报 146 张
 *   图集缩略图条划不动）：悬浮层的 touchstart/move/end 同样
 *   stopPropagation——只拦 click 时，条上横拖的 touchend 冒泡到舞台
 *   被认成横滑翻页，idx 一变跟随滚动又把条拉回当前张，条永远停
 *   不住、定不了位。触摸起源于悬浮层即与舞台手势完全隔离；条
 *   本体 touchAction: pan-x 交浏览器原生横滚（带惯性快速定位），
 *   缩略图点选跳张不变。舞台另补 touchcancel 清起点，防浏览器
 *   接管滚动后残留起点污染下一次手势。
 * - 契约不变：index 完全受控于调用方（计数/跳张同步一份状态）、
 *   缩略图点选跳张且当前张高亮并滚动定位、返回/关闭由调用方注入。
 * - 快速滑动不消失（Muse 2026-11-19 fix330/ui-fixes，用户真机实
 *   报「图片预览滑的快了会直接消失隐藏」）：双机制——(1) 舞台窗口
 *   化：只挂当前张±1 三帧、邻图随挂载即预取，旧单 Img 逐张重挂
 *   在慢图源下快翻张张空白；(2) chrome 活动续命：缩略图条滚动/
 *   悬浮层触摸都算「还在用 chrome」，淡出计时据此重置，旧计时
 *   只挂呼出/切张，条上划找图满 3 秒整层在指下淡出。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { GESTURE_EDGE_PX } from "../../shared/lib/gestureGate";
import { Button } from "../../shared/ui/ios/controls";
import { Img } from "../../shared/ui/ui";
import { IBack, IClose } from "../../shared/ui/icons";

export const ALBUM_CHROME_IDLE_MS = 3000;

export function AlbumViewer({ title, images, index, onIndexChange, onBack, backLabel, onClose, closeLabel = "关闭大图", footerNote }: {
  title: string;
  images: string[];
  index: number;
  onIndexChange: (index: number) => void;
  onBack: () => void;
  backLabel: string;
  onClose?: () => void;
  closeLabel?: string;
  footerNote?: string;
}) {
  const [chrome, setChrome] = useState(true);
  /* chrome 活动计数（fix330/ui-fixes）：悬浮层上的滚动/触摸经
   * pokeChrome 节流递增，淡出计时以它为依赖重置——在条上持续
   * 划动找图期间 chrome 不淡出，停手后照常 3 秒淡出。 */
  const [chromeActivity, setChromeActivity] = useState(0);
  const pokeRef = useRef(0);
  const pokeChrome = useCallback(() => {
    const now = Date.now();
    if (now - pokeRef.current < 500) return;
    pokeRef.current = now;
    setChromeActivity((n) => n + 1);
  }, []);
  const touchRef = useRef<{ x: number; y: number } | null>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const idx = Math.min(Math.max(0, index), Math.max(0, images.length - 1));

  const go = useCallback((next: number) => {
    if (next < 0 || next >= images.length || next === idx) return;
    onIndexChange(next);
  }, [images.length, idx, onIndexChange]);

  /* 悬浮层自动淡出：呼出/切张/chrome 上有活动后重新计时，静止
   * ALBUM_CHROME_IDLE_MS 淡出（活动续命 fix330/ui-fixes）。 */
  useEffect(() => {
    if (!chrome) return;
    const t = window.setTimeout(() => setChrome(false), ALBUM_CHROME_IDLE_MS);
    return () => window.clearTimeout(t);
  }, [chrome, idx, chromeActivity]);

  /* 当前缩略图定位：切张后把当前张滚进缩略图条可视区中央。 */
  useEffect(() => {
    if (!chrome) return;
    stripRef.current?.querySelector(`[data-thumb-index="${idx}"]`)
      ?.scrollIntoView({ inline: "center", block: "nearest" });
  }, [chrome, idx]);

  const onStageClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const fx = (e.clientX - r.left) / Math.max(1, r.width);
    if (fx < 1 / 3) { go(idx - 1); setChrome(true); }
    else if (fx > 2 / 3) { go(idx + 1); setChrome(true); }
    else setChrome((v) => !v);
  };

  const chromeCls = `transition-opacity duration-300 ${chrome ? "opacity-100" : "opacity-0 pointer-events-none"}`;
  /* 悬浮层手势隔离：click 与全部 touch 事件都不冒泡到舞台——条上
   * 横滚、顶栏拖动一律不触发舞台横滑/点按判定（fix322/gallery）；
   * 同时 touch 即 chrome 活动、续命淡出计时（fix330/ui-fixes）。 */
  const stopTouch = (e: React.TouchEvent) => { e.stopPropagation(); pokeChrome(); };

  return (
    <div data-ui="album-viewer-stage" className="relative h-full w-full overflow-hidden bg-black select-none"
      onClick={onStageClick}
      onTouchStart={(e) => {
        const t = e.touches[0];
        touchRef.current = t ? { x: t.clientX, y: t.clientY } : null;
      }}
      onTouchEnd={(e) => {
        const start = touchRef.current;
        touchRef.current = null;
        const t = e.changedTouches[0];
        if (!start || !t) return;
        const dx = t.clientX - start.x;
        const dy = t.clientY - start.y;
        /* 边缘起手归壳层链返回（fix330/gesture-back 一致性批）：与
           Feed 面 scrub 同一归属口径——左右缘 GESTURE_EDGE_PX 内
           起手不翻页。旧版舞台无归属：频道页（栈页）内边缘右滑翻
           上一张与 chain pop 同时成立、用户被划出页面；搜索详情
           内的图集此前靠外层 dialog 祖先挡链才幸免，行为按入口
           分叉（结构审计 C⑤ 点名）。 */
        if (start.x <= GESTURE_EDGE_PX || window.innerWidth - start.x <= GESTURE_EDGE_PX) return;
        if (Math.abs(dx) >= 48 && Math.abs(dx) > Math.abs(dy)) { go(dx < 0 ? idx + 1 : idx - 1); setChrome(true); }
      }}
      onTouchCancel={() => { touchRef.current = null; }}>
      {/* 窗口化舞台（fix330/ui-fixes）：只挂当前张±1 三帧、仅当
          前张不透明。旧实现单 Img 以 src 为 key 逐张重挂——每张
          从空白/微光起步、无邻图预载，慢图源下快速连翻必然张张
          追不上、舞台空白如「消失」。窗口帧按 index 定 key、随
          idx 滑动复用：已挂载帧的 Img 不重走 attempt，邻图在被
          翻到前已经预取解码；非当前帧 opacity-0（不影响 Img 的
          视口 attempt 门，几何仍在场）。 */}
      {images.slice(Math.max(0, idx - 1), Math.min(images.length, idx + 2)).map((src, k) => {
        const i = Math.max(0, idx - 1) + k;
        return (
          <div key={i} data-album-frame={i} className="absolute inset-0"
            style={{ opacity: i === idx ? 1 : 0, pointerEvents: "none" }} aria-hidden={i !== idx}>
            <Img src={src} alt={i === idx ? title : ""} eager fit="contain" />
          </div>
        );
      })}
      {/* 顶部悬浮层：返回 + 标题 + 计数 + 关闭 */}
      <div data-album-chrome="top" className={`absolute inset-x-0 top-0 z-10 ${chromeCls}`}
        onClick={(e) => e.stopPropagation()}
        onTouchStart={stopTouch} onTouchMove={stopTouch} onTouchEnd={stopTouch}>
        <div className="flex items-center gap-2 px-3 pt-3 pb-6 bg-gradient-to-b from-black/60 to-transparent">
          <Button aria-label={backLabel} onClick={onBack}
            className="grid place-items-center w-11 h-11 shrink-0 rounded-full bg-black/40 text-white"><IBack size={20} /></Button>
          <h2 className="flex-1 min-w-0 truncate text-[15px] font-bold text-white">{title}</h2>
          <span data-ui="album-viewer-count" className="shrink-0 text-[12px] text-white/85">{idx + 1} / {images.length}</span>
          {onClose && (
            <Button aria-label={closeLabel} onClick={onClose}
              className="grid place-items-center w-11 h-11 shrink-0 rounded-full bg-black/40 text-white"><IClose size={18} /></Button>
          )}
        </div>
      </div>
      {/* 底部悬浮层：来源注记 + 缩略图条（默认隐藏，随悬浮层呼出才在场） */}
      <div data-album-chrome="bottom" className={`absolute inset-x-0 bottom-0 z-10 ${chromeCls}`}
        onClick={(e) => e.stopPropagation()}
        onTouchStart={stopTouch} onTouchMove={stopTouch} onTouchEnd={stopTouch}>
        <div className="px-3 pt-6 pb-3 bg-gradient-to-t from-black/60 to-transparent">
          {footerNote && <p className="mb-2 text-[12px] text-white/75">{footerNote}</p>}
          {images.length > 1 && (
            <div ref={stripRef} className="scroll-x flex gap-2" role="group" aria-label="相册图片缩略图"
              style={{ touchAction: "pan-x" }} onScroll={pokeChrome}>
              {images.map((src, i) => (
                <Button key={`${src}-${i}`} data-thumb-index={i} aria-label={`第 ${i + 1} 张`} aria-pressed={i === idx}
                  onClick={() => onIndexChange(i)}
                  className={`relative h-16 w-12 shrink-0 overflow-hidden rounded-[8px] ${i === idx ? "ring-2 ring-primary" : "opacity-70"}`}>
                  <Img src={src} alt="" />
                </Button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
