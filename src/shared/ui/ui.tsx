import { Button, Image, Surface } from "./ios/controls";
import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cover, platform } from "../api/api";
import { getFullscreenElement, onFullscreenChange } from "../lib/fullscreen";
import { imageDisplayed, imageFailed, imageRetry, imageStarted, recordImageFailure, traceFeed, urlFingerprint } from "../lib/feedTrace";
export { Sheet, Modal } from "./ios/overlays";
import { useToasts } from "../model/store";
import { Loader } from "./ios/effects";
import { IBoltF, ICheck, IGlobe, IHeartF, IMinus, ISparkF, IStarF } from "./icons";

/* ——— 头像 ——— */
export function Avatar({ hue = 250, icon, name, size = 40, ring = false, className = "" }: {
  hue?: number; icon?: React.ReactNode; name?: string; size?: number; ring?: boolean; className?: string;
}) {
  const inner = (
    <div className="w-full h-full rounded-full flex items-center justify-center overflow-hidden font-semibold"
      style={{ background: `hsl(${hue} 22% 30%)`, color: `hsl(${hue} 70% 88%)` }}>
      {icon ?? <span style={{ fontSize: size * 0.42 }} className="leading-none">{(name || "H").replace(/^@/, "")[0].toUpperCase()}</span>}
    </div>
  );
  return (
    <div className={`shrink-0 ${className}`} style={{ width: size, height: size }}>
      {ring ? <div className="w-full h-full rounded-full p-[2px] bg-primary"><div className="w-full h-full rounded-full bg-bg p-[2px]">{inner}</div></div> : inner}
    </div>
  );
}

/* ——— 开关 ——— */
export function Toggle({ on, onChange, label, disabled = false, desktop = false }: {
  on: boolean; onChange: (b: boolean) => void; label?: string; disabled?: boolean; desktop?: boolean;
}) {
  return (
    <Button disabled={disabled} onClick={() => onChange(!on)} role="switch" aria-checked={on} aria-label={label}
      className="ios-switch" data-platform={desktop ? "desktop" : platform} data-state={on ? "on" : "off"}>
      <span className="ios-switch-track" aria-hidden="true">
        <span className="ios-switch-thumb">
          <ICheck size={14} className="ios-switch-mark is-on" />
          <IMinus size={14} className="ios-switch-mark is-off" />
        </span>
      </span>
    </Button>
  );
}

/* ——— 空状态 ——— */
export function Empty({ icon, title, sub, action, onAction }: {
  icon: React.ReactNode; title: string; sub?: string; action?: string; onAction?: () => void;
}) {
  return (
    <div className="ios-empty flex flex-col items-center justify-center py-16 px-8 text-center a-rise">
      <div className="w-16 h-16 rounded-(--r-md) tonal flex items-center justify-center mb-4">{icon}</div>
      <div className="text-[16px] font-semibold text-on/90">{title}</div>
      {sub && <div className="text-xs text-mut mt-1.5 leading-relaxed">{sub}</div>}
      {action && (
        <Button onClick={onAction} className="mt-5 px-6 h-10 rounded-(--r-ctl) bg-primary text-on-primary text-[14px] font-bold pressable">{action}</Button>
      )}
    </div>
  );
}

/* ——— Toast ——— */
export function ToastHost() {
  const toasts = useToasts();
  const [fsHost, setFsHost] = useState<Element | null>(() => getFullscreenElement());
  useEffect(() => onFullscreenChange(() => setFsHost(getFullscreenElement())), []);
  const content = (
    <div role="status" aria-live="polite" aria-atomic="true" className="ios-toast-host absolute inset-x-0 z-[300] flex flex-col items-center gap-2 pointer-events-none px-6" style={{ bottom: "calc(var(--sab, 0px) + 96px)" }}>
      {toasts.map((t) =>
        t.line ? (
          <div
            key={t.id}
            className="a-toast pointer-events-auto relative flex items-center gap-2.5 max-w-full bg-s4/80 backdrop-blur-2xl rounded-[16px] pl-2 pr-3 py-2 elev-3 ring-1 ring-white/10"
          >
            <span
              className={`grid place-items-center size-9 rounded-[12px] shrink-0 ${
                t.line.region === "cn"
                  ? "bg-mint/15 text-mint"
                  : "bg-cyan/15 text-cyan"
              }`}
            >
              {t.line.region === "cn" ? <IBoltF size={17} /> : <IGlobe size={17} />}
            </span>
            <div className="min-w-0">
              <div className="text-[14px] font-semibold text-on leading-tight">
                {t.line.region === "cn" ? "国内线路" : "国外线路"}
              </div>
              <div className="text-[12px] text-dim leading-tight mt-0.5 truncate">{t.line.host}</div>
            </div>
            <div className="ml-1.5 flex items-baseline gap-0.5 shrink-0 pl-2.5 border-l border-white/10">
              <span
                className={`text-[16px] font-bold tabular-nums ${
                  t.line.ms <= 0
                    ? "text-dim"
                    : t.line.ms < 500
                      ? "text-mint"
                      : t.line.ms < 1000
                        ? "text-amber"
                        : "text-danger"
                }`}
              >
                {t.line.ms > 0 ? t.line.ms : "—"}
              </span>
              {t.line.ms > 0 && <span className="text-[12px] font-semibold text-dim">ms</span>}
            </div>
          </div>
        ) : (
          <Surface key={t.id} className="a-toast pointer-events-auto flex items-center gap-2.5 max-w-full bg-s4/95 backdrop-blur-md rounded-(--r-sm) pl-3.5 pr-4 py-2.5 elev-3">
            {t.icon === "ok" && <ICheck size={16} className="text-mint shrink-0" />}
            {t.icon === "heart" && <IHeartF size={16} className="text-neon shrink-0" />}
            {t.icon === "star" && <IStarF size={16} className="text-amber shrink-0" />}
            {t.icon === "info" && <ISparkF size={15} className="text-cyan shrink-0" />}
            <span className="text-[14px] text-on leading-snug clamp-2 break-words">{t.msg}</span>
          </Surface>
        ),
      )}
    </div>
  );
  return fsHost ? createPortal(content, fsHost) : content;
}

/* ——— 图片（骨架 + 渐显，自动走本地解密协议） ——— */
export function Img({ src, alt = "", className = "", eager = false, raw = false, loadingIndicator = false, fit = "cover" }: {
  src: string; alt?: string; className?: string; eager?: boolean; raw?: boolean; loadingIndicator?: boolean;
  /* fit（Muse 2026-11-19 3.2.1修复F6线）：默认 cover 与既有封面口径
   * 不变；全屏图集查看器传 contain——照片完整贴边、不裁切。 */
  fit?: "cover" | "contain";
}) {
  const url = raw ? src : cover(src);
  // 每个地址独立持有状态，避免换图后的 effect 把缓存命中的 onLoad 重置掉。
  return <ImageLoad key={url} url={url} alt={alt} className={className} eager={eager} raw={raw} loadingIndicator={loadingIndicator} fit={fit} />;
}

/* 封面加载状态机（Muse 2026-11-19 fix2 A3）：loading→decoded→
 * displayed / failed(reason)。旧实现只有 ok/err 两态且无超时——慢线
 * 下请求悬挂时 shimmer 永远转、失败原因不可见（真机：一整屏封面
 * 黑占位，无从判读是没拉到、超时还是解码失败）。现行：每 attempt
 * 带 20s 超时（超时记 timeout 并走既有重试），onLoad 记 decoded、
 * 下一帧记 displayed；终局失败按原因计入 feedTrace 聚合，诊断
 * 报告可读。视觉与重试策略不变：同地址重试两次再落占位。
 * 超时起算点（fix2.1 整改，GPT 四审 #1）：自「实际加载开始」计——
 * img 是 loading="lazy"，视口外封面浏览器根本不发请求，旧实现自
 * 挂载起算 20s，离屏 60s 即烧光 3 次 attempt、settledRef 锁死，
 * 之后滚到图也永不显示。故 attempt 计时只在封面进入视口预热区
 * （IntersectionObserver，rootMargin 600px ≈ 浏览器开始 lazy 加载
 * 的距离）后启动；eager 图挂载即起算。一旦起算不再随滚动撤销
 * （请求已在路上，滚出视口不等于没在加载）。 */
type ImgState = "loading" | "decoded" | "displayed" | "failed";
const IMG_ATTEMPT_TIMEOUT_MS = 20_000;
function ImageLoad({ url, alt, className, eager, raw, loadingIndicator, fit = "cover" }: {
  url: string; alt: string; className: string; eager: boolean; raw: boolean; loadingIndicator: boolean; fit?: "cover" | "contain";
}) {
  const [state, setState] = useState<ImgState>("loading");
  const [attempt, setAttempt] = useState(0);
  /* 加载起算门：false 时 attempt 计时不启动（见上方注释）。 */
  const [armed, setArmed] = useState(eager);
  const frameRef = useRef<HTMLDivElement>(null);
  const settledRef = useRef(false);
  /* 逐图失败明细的耗时锚点（fix331/gallery-device）：首 attempt 起算
   * 与当前 attempt 起算，供终局记录算总耗时档/末次耗时档。 */
  const firstStartRef = useRef(0);
  const attemptStartRef = useRef(0);
  const ok = state === "decoded" || state === "displayed";
  const err = state === "failed";
  /* 封面走本地解密代理，网络抖动会偶发失败：同地址重试两次再落到占位。
     代理入口只读 `u`，多余查询参数会被忽略，用它做重试的缓存戳。 */
  const retryUrl = !url || raw || attempt === 0 ? url : `${url}${url.includes("?") ? "&" : "?"}r=${attempt}`;
  /* 已加载对账（Muse 2026-11-19 fix330/gallery-viewer）：load 事件与
   * attempt 时钟是两条独立通道——事件可能早于 armed 翻转到达（effect
   * 重跑把 settledRef 重置并重启 20s 计时，src 不变则再无 load 事件
   * 落座，计时必然误判 timeout），也可能被缓存同步完成吞掉。真机
   * 实证：图集缩略图已显示却在约 20s 后被误判超时换址重拉，慢通道
   * 下三次 attempt 烧光落终局 HG、迟到的真实加载又被 settled 守卫
   * 丢弃，全条只剩占位。故 effect 起算前与 timeout 裁决前都先与
   * DOM img 的真实状态对账：已 complete 且有自然尺寸即按已加载
   * 落座，不起算、不烧 attempt。 */
  const settleOkFromDom = () => {
    const imgEl = frameRef.current?.querySelector("img");
    if (!imgEl || !imgEl.complete || imgEl.naturalWidth <= 0) return false;
    if (!settledRef.current) {
      settledRef.current = true;
      traceFeed("image", { ev: "decoded", attempt, url: urlFingerprint(url) });
      imageDisplayed();
    }
    setState((s) => (s === "displayed" ? s : "decoded"));
    requestAnimationFrame(() => setState((s) => (s === "decoded" ? "displayed" : s)));
    return true;
  };
  useEffect(() => {
    if (armed) return;
    const el = frameRef.current;
    if (!el || typeof IntersectionObserver !== "function") { setArmed(true); return; }
    const io = new IntersectionObserver(
      (entries) => { if (entries.some((e) => e.isIntersecting)) setArmed(true); },
      { rootMargin: "600px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [armed]);
  useEffect(() => {
    if (!url || !armed) return;
    /* 起算前对账（fix330/gallery-viewer）：已加载的图不起算、不重置
     * settled——armed 翻转引发的 effect 重跑不得烧掉已落座的加载。 */
    if (settleOkFromDom()) return;
    settledRef.current = false;
    imageStarted();
    const fp = urlFingerprint(url);
    const startedAt = Date.now();
    attemptStartRef.current = startedAt;
    if (!firstStartRef.current) firstStartRef.current = startedAt;
    traceFeed("image", { ev: "loading", attempt, url: fp });
    const failOrRetry = (reason: "timeout" | "network" | "decode") => {
      if (settledRef.current) return;
      /* timeout 裁决前再对账：计时期间图可能已经真实到达（事件被
       * 吞），DOM 已 complete 时按已加载落座，不误烧 attempt。 */
      if (reason === "timeout" && settleOkFromDom()) return;
      settledRef.current = true;
      traceFeed("image", { ev: "failed", attempt, url: fp, reason, ms: Date.now() - startedAt });
      if (!raw && attempt < 2) {
        imageRetry();
        setState("loading");
        setAttempt(attempt + 1);
      } else {
        imageFailed(reason);
        recordImageFailure({
          fp, stage: reason === "timeout" ? "attempt-timeout" : "error-event", reason,
          attempts: attempt + 1,
          totalMs: Date.now() - (firstStartRef.current || startedAt),
          lastMs: Date.now() - startedAt,
        });
        setState("failed");
      }
    };
    const timer = window.setTimeout(() => failOrRetry("timeout"), IMG_ATTEMPT_TIMEOUT_MS);
    return () => {
      window.clearTimeout(timer);
      if (!settledRef.current) { settledRef.current = true; imageRetry(); }
    };
    // failOrRetry 捕获当前 attempt 的闭包即可（attempt 变更即新 effect）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, attempt, raw, armed]);
  return (
    <div ref={frameRef} className={`ios-image absolute inset-0 overflow-hidden ${className}`} data-ui="image-frame">
      {!ok && !err && <div className="absolute inset-0 shimmer" />}
      {loadingIndicator && !ok && <div className="absolute inset-0 grid place-items-center"><Loader label="封面加载中" /></div>}
      {err && !loadingIndicator && <div className="ios-image-error" role="img" aria-label={alt || "封面暂不可用"}>HG</div>}
      {url && <Image src={retryUrl} alt={alt} loading={eager ? "eager" : "lazy"}
        onLoad={() => {
          if (settledRef.current) return;
          settledRef.current = true;
          traceFeed("image", { ev: "decoded", attempt, url: urlFingerprint(url) });
          imageDisplayed();
          setState("decoded");
          requestAnimationFrame(() => setState((s) => (s === "decoded" ? "displayed" : s)));
        }}
        onError={(e) => {
          if (settledRef.current) return;
          /* img 错误事件不区分网络与解码：naturalWidth=0 多为网络/
           * 空响应记 network，其余记 decode——近似口径，trace 如实记。 */
          const el = e.currentTarget as HTMLImageElement;
          const reason = el.naturalWidth === 0 ? "network" : "decode";
          settledRef.current = true;
          traceFeed("image", { ev: "error", attempt, url: urlFingerprint(url), reason });
          if (!raw && attempt < 2) {
            imageRetry();
            setState("loading");
            setAttempt(attempt + 1);
          } else {
            imageFailed(reason);
            recordImageFailure({
              fp: urlFingerprint(url), stage: reason === "decode" ? "decode" : "error-event", reason,
              attempts: attempt + 1,
              totalMs: Date.now() - (firstStartRef.current || attemptStartRef.current || Date.now()),
              lastMs: Date.now() - (attemptStartRef.current || Date.now()),
            });
            setState("failed");
          }
        }}
        className={`absolute inset-0 w-full h-full ${fit === "contain" ? "object-contain" : "object-cover"} transition-opacity duration-300 ${ok ? "opacity-100" : "opacity-0"}`} draggable={false} />}
    </div>
  );
}
