import { useEffect, useRef, useState, type ChangeEvent, type MouseEvent, type PointerEvent } from "react";

type Props = {
  time: number; duration: number; enabled?: boolean; resetKey?: string;
  onSeek: (time: number, input: string) => void;
  onInteraction?: (phase: string, input: string, target: number, pointerTarget?: number) => void;
};

/** Preview pointer movement locally; commit a single seek on release. Keyboard stays native.
 * scrub 仲裁（最终版 B2 线追加，用户实报「拖进度条极易误触别的界面」）：
 * 指针位移过 moved 阈值（3px）即进入 scrub——经 onInteraction 发
 * scrubstart(drag) 一次、结束（up/cancel）发 scrubend(drag) 一次，并以
 * scrubbing 状态对外；两宿主（Feed 桌面 PlayerControls／帖子 Player）
 * 消费同一份仲裁，不许各写一套。拖动结束后紧随的 click 由本层吞掉
 * （见 inputProps.onClick），宿主的 click 类处理器（显隐/切换播放）
 * 不许被一次拖动误触。 */
export function useSeekInput({ time, duration, enabled = true, resetKey, onSeek, onInteraction }: Props) {
  const [preview, setPreview] = useState<number | null>(null);
  const [scrubbing, setScrubbing] = useState(false);
  const pointer = useRef<{ id: number; x: number; moved: boolean; scrub: boolean; target: number; el: HTMLInputElement } | null>(null);
  const latest = useRef({ onSeek, onInteraction }); latest.current = { onSeek, onInteraction };
  /* 最近一次拖动结束时刻：其后 500ms 内的 click 视为同次手势的尾巴。 */
  const lastDragAt = useRef(0);
  const seekable = enabled && Number.isFinite(duration) && duration > 0;
  const release = () => {
    const p = pointer.current; pointer.current = null;
    if (p?.el.hasPointerCapture(p.id)) p.el.releasePointerCapture(p.id);
  };
  const endScrub = (target: number) => {
    lastDragAt.current = Date.now();
    latest.current.onInteraction?.("scrubend", "drag", target);
    setScrubbing(false);
  };
  const cancel = () => {
    const p = pointer.current;
    if (p?.scrub) endScrub(p.target);
    if (p) latest.current.onInteraction?.("cancel", p.moved ? "drag" : "click", p.target);
    release(); setPreview(null);
  };
  useEffect(() => { cancel(); }, [seekable, duration, resetKey]);
  useEffect(() => () => { release(); }, []);
  const targetAt = (e: PointerEvent<HTMLInputElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return rect.width ? Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * duration : 0;
  };
  const displayTime = preview ?? time;
  return {
    time: displayTime,
    scrubbing,
    inputProps: {
      disabled: !seekable, min: 0, max: seekable ? duration : 1, step: .01,
      value: Math.max(0, Math.min(displayTime, seekable ? duration : 0)),
      style: { touchAction: "none" },
      onPointerDown: (e: PointerEvent<HTMLInputElement>) => {
        if (!seekable || e.button !== 0 || pointer.current) return;
        e.preventDefault();
        e.currentTarget.focus({ preventScroll: true });
        const target = targetAt(e);
        pointer.current = { id: e.pointerId, x: e.clientX, moved: false, scrub: false, target, el: e.currentTarget };
        e.currentTarget.setPointerCapture(e.pointerId);
        setPreview(target);
        latest.current.onInteraction?.("down", "pointer", time, target);
        latest.current.onInteraction?.("change", "click", target);
      },
      onPointerMove: (e: PointerEvent<HTMLInputElement>) => {
        const p = pointer.current;
        if (!p || p.id !== e.pointerId) return;
        if (Math.abs(e.clientX - p.x) > 3) p.moved = true;
        p.target = targetAt(e); setPreview(p.target);
        /* scrub 成立点：moved 首次翻真——此后宿主须屏蔽竖滑切视频/
         * 页面滚动/单击显隐直至 scrubend（锁已成立，竖向超阈不转交）。 */
        if (p.moved && !p.scrub) {
          p.scrub = true;
          setScrubbing(true);
          latest.current.onInteraction?.("scrubstart", "drag", p.target);
        }
        latest.current.onInteraction?.("change", p.moved ? "drag" : "click", p.target);
      },
      onPointerUp: (e: PointerEvent<HTMLInputElement>) => {
        const p = pointer.current;
        if (!p || p.id !== e.pointerId) return;
        const target = targetAt(e), input = p.moved ? "drag" : "click";
        const wasScrub = p.scrub;
        release(); setPreview(null);
        latest.current.onInteraction?.("up", input, target);
        if (seekable) latest.current.onSeek(target, input);
        if (wasScrub) endScrub(target);
      },
      onClick: (e: MouseEvent<HTMLInputElement>) => {
        /* click-after-drag 吞咽：拖动后的 click 是同次手势的尾巴，
         * 只许落在本输入上，不许冒泡去触发宿主的显隐/播放切换；
         * 无位移的普通点击不吞（其 seek 已由 pointerup 路径提交）。 */
        if (lastDragAt.current && Date.now() - lastDragAt.current < 500) {
          lastDragAt.current = 0;
          e.preventDefault();
          e.stopPropagation();
        }
      },
      onPointerCancel: cancel,
      onLostPointerCapture: () => { if (pointer.current) cancel(); },
      onBlur: cancel,
      onChange: (e: ChangeEvent<HTMLInputElement>) => {
        if (!seekable || pointer.current) return;
        const target = Number(e.target.value);
        latest.current.onInteraction?.("change", "keyboard", target);
        latest.current.onSeek(target, "keyboard");
      },
    },
  };
}
