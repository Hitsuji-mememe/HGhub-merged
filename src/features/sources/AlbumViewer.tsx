/**
 * 全屏图集查看器（Muse 2026-11-19 3.2.1修复F6线，用户实报图集图片
 * 太小后定版的主流形态，SourceGallery 与搜索图片详情共用）：
 * - 舞台即全区：根容器由调用方以 fixed inset-0 覆满视口（两宿主
 *   同形态，见文件头「宿主形态收敛」），图片 fit="contain"
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
 * - 沉浸式安全区（Muse 2026-11-19 fix330/gallery-viewer，用户真
 *   机实报全屏 chrome 与 iOS 状态栏同带重叠）：immersive 模式下
 *   顶部/底部 chrome 按 --sat/--sab/--sal/--sar 让位（与 Feed 全屏
 *   chrome 同口径）；fixed 覆满视口的宿主必须传 immersive。舞台
 *   本体保持全幅出血、不让位。
 * - 宿主形态收敛（Muse 2026-11-20 fix336/ui-fixes，用户真机实
 *   报）：两个宿主（SourceGallery 源内、Search 搜索详情）现均为
 *   fixed inset-0 z-40 顶层覆盖＋immersive——搜索宿主旧形态是详
 *   情页内 h-full 内嵌＋不传 immersive，实报双标题栏（详情页头
 *   漏出）＋壳底部导航漏出，「宿主页已处理安全区」的旧假设就此
 *   作废；新宿主接入一律按此形态，不许再内嵌。
 * - 底栏让位（Muse 2026-11-20 fix337/album-chrome，3.3.6 真机
 *   复报）：fixed＋z-40 只盖得住宿主上下文内的页面——壳底栏
 *   （.ios-mobile-nav，z-50）在 App 根层同级，搜索宿主的覆层
 *   又嵌在详情层（absolute z-30）的层叠上下文里，z-40 出不了
 *   上下文，底栏胶囊恒压缩略图条下半截。故宿主义务加一条：
 *   查看器在场期间持有 store.tabBarHeld（与 fs/clean 同口径
 *   整栏不渲染），关闭/卸载释放；源内宿主只在栈页（底栏本不
 *   渲染）持有为空转，同口径防宿主迁移复发。新宿主接入两条
 *   义务缺一不可。
 * - 缩略图随可见性加载（同线，用户真机实报全条只有当前张有图、
 *   其余全是 HG 占位）：旧实现全量 lazy 挂载——浏览器原生 lazy
 *   以条滚动口为取图窗口、Img attempt 时钟以主视口 IO 为起算窗
 *   口，两窗口脱节，慢通道下 attempt 烧光落终局失败。现以条本
 *   体为 root 的 IO 闩锁（nearThumbs）：进窗（含 600px 预取边
 *   距）才挂 Img 且 eager 取图，挂载即取图、时钟同点起算；窗外
 *   只占位、不挂 Img、不发请求、不起时钟，滚动到哪加载到哪。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { GESTURE_EDGE_PX } from "../../shared/lib/gestureGate";
import { Button } from "../../shared/ui/ios/controls";
import { Img } from "../../shared/ui/ui";
import { IBack, IClose } from "../../shared/ui/icons";

export const ALBUM_CHROME_IDLE_MS = 3000;

export function AlbumViewer({ title, images, index, onIndexChange, onBack, backLabel, onClose, closeLabel = "关闭大图", footerNote, immersive = false, headerAction, page }: {
  title: string;
  images: string[];
  index: number;
  onIndexChange: (index: number) => void;
  onBack: () => void;
  backLabel: string;
  onClose?: () => void;
  closeLabel?: string;
  footerNote?: string;
  /* 页面上下文（Muse 2026-11-20 fix338/realphoto-add）：本组图片
   * 所在的详情页地址，透传给每张 Img 的 page 参（/img Referer 候
   * 选链）；宿主不知/不适用时不传、行为不变。 */
  page?: string;
  /** 顶栏动作槽（fix334/L3）：宿主可选注入（如图集收藏钮），渲染
   * 在计数与关闭之间、随 chrome 一同淡出；不传则顶栏与旧形态逐字
   * 一致（Search 图片详情不传、不受影响）。 */
  headerAction?: ReactNode;
  /* immersive：宿主为 fixed 覆满视口的全屏形态时为 true，chrome
   * 按安全区变量让位（见文件头注）；现行两宿主均为该形态。 */
  immersive?: boolean;
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

  /* 缩略图可见性闩锁（fix330/gallery-viewer，见文件头注）：以条
   * 本体为 root 观察每个缩略图格，进窗（左右各 600px 预取边距，
   * 与 Img 视口预热同量级）即闩锁常驻——闩锁后挂 Img eager 取
   * 图，此后不卸载（已解码图不重走 attempt）；未闩锁的格只渲染
   * 占位、不产生请求与时钟。images 换组（换相册）时重置重观察。 */
  const [nearThumbs, setNearThumbs] = useState<ReadonlySet<number>>(new Set());
  useEffect(() => {
    setNearThumbs(new Set());
    const root = stripRef.current;
    if (!root) return;
    if (typeof IntersectionObserver !== "function") {
      setNearThumbs(new Set(images.map((_, i) => i)));
      return;
    }
    const io = new IntersectionObserver((entries) => {
      setNearThumbs((prev) => {
        let next: Set<number> | null = null;
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const i = Number((e.target as HTMLElement).dataset.thumbIndex);
          if (Number.isFinite(i) && !prev.has(i)) { next ??= new Set(prev); next.add(i); }
        }
        return next ?? prev;
      });
    }, { root, rootMargin: "0px 600px 0px 600px" });
    root.querySelectorAll("[data-thumb-index]").forEach((el) => io.observe(el));
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [images]);

  const onStageClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const fx = (e.clientX - r.left) / Math.max(1, r.width);
    if (fx < 1 / 3) { go(idx - 1); setChrome(true); }
    else if (fx > 2 / 3) { go(idx + 1); setChrome(true); }
    else setChrome((v) => !v);
  };

  const chromeCls = `transition-opacity duration-300 ${chrome ? "opacity-100" : "opacity-0 pointer-events-none"}`;
  /* chrome 安全区让位（fix330/gallery-viewer）：immersive 时内边
   * 距＝安全区变量＋原 12px 呼吸距（--sat 本身已是 max(原生,
   * env(), 12px)，顶栏再叠 12px 与 Feed 全屏 chrome 口径一致）；
   * 非 immersive 保持原 12px 写死值，页内嵌形态外观不变。 */
  const topChromeStyle: React.CSSProperties = immersive
    ? { paddingTop: "calc(var(--sat, 0px) + 12px)", paddingLeft: "calc(var(--sal, 0px) + 12px)", paddingRight: "calc(var(--sar, 0px) + 12px)" }
    : { paddingTop: 12, paddingLeft: 12, paddingRight: 12 };
  const bottomChromeStyle: React.CSSProperties = immersive
    ? { paddingBottom: "calc(var(--sab, 0px) + 12px)", paddingLeft: "calc(var(--sal, 0px) + 12px)", paddingRight: "calc(var(--sar, 0px) + 12px)" }
    : { paddingBottom: 12, paddingLeft: 12, paddingRight: 12 };
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
            <Img src={src} alt={i === idx ? title : ""} eager fit="contain" page={page} />
          </div>
        );
      })}
      {/* 顶部悬浮层：返回 + 标题 + 计数 + 关闭 */}
      <div data-album-chrome="top" className={`absolute inset-x-0 top-0 z-10 ${chromeCls}`}
        onClick={(e) => e.stopPropagation()}
        onTouchStart={stopTouch} onTouchMove={stopTouch} onTouchEnd={stopTouch}>
        <div className="flex items-center gap-2 pb-6 bg-gradient-to-b from-black/60 to-transparent" style={topChromeStyle}>
          <Button aria-label={backLabel} onClick={onBack}
            className="grid place-items-center w-11 h-11 shrink-0 rounded-full bg-black/40 text-white"><IBack size={20} /></Button>
          <h2 className="flex-1 min-w-0 truncate text-[15px] font-bold text-white">{title}</h2>
          <span data-ui="album-viewer-count" className="shrink-0 text-[12px] text-white/85">{idx + 1} / {images.length}</span>
          {headerAction}
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
        <div className="pt-6 bg-gradient-to-t from-black/60 to-transparent" style={bottomChromeStyle}>
          {footerNote && <p className="mb-2 text-[12px] text-white/75">{footerNote}</p>}
          {images.length > 1 && (
            <div ref={stripRef} className="scroll-x flex gap-2" role="group" aria-label="相册图片缩略图"
              style={{ touchAction: "pan-x" }} onScroll={pokeChrome}>
              {images.map((src, i) => (
                <Button key={`${src}-${i}`} data-thumb-index={i} aria-label={`第 ${i + 1} 张`} aria-pressed={i === idx}
                  onClick={() => onIndexChange(i)}
                  className={`relative h-16 w-12 shrink-0 overflow-hidden rounded-[8px] ${i === idx ? "ring-2 ring-primary" : "opacity-70"}`}>
                  {/* 闩锁进窗才挂图（nearThumbs，见文件头注）：窗外
                      只占位，点选跳张不依赖图已挂载、照常可用。 */}
                  {nearThumbs.has(i)
                    ? <Img src={src} alt="" eager page={page} />
                    : <span aria-hidden className="absolute inset-0 bg-white/10" />}
                </Button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
