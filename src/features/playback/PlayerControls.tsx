import { Button, Input } from "../../shared/ui/ios/controls";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { fmtTime } from "../../shared/api/api";
import { useSeekInput } from "./useSeekInput";
import { ICheck, ICompress, IExpand, INext, IPauseF, IPlayF, IVol, IVolMute } from "../../shared/ui/icons";
import type { PlaybackClock } from "./playbackClock";

type Props = {
  paused: boolean;
  clock: PlaybackClock;
  duration: number;
  buffered?: number;
  rate: number;
  muted: boolean;
  volume: number;
  fullscreen?: boolean;
  dockInset?: number;
  visible?: boolean;
  seekEnabled?: boolean;
  seekKey?: string;
  nextDisabled?: boolean;
  nextTitle?: string;
  onToggle: () => void;
  onSeek: (t: number, source?: string) => void;
  onSeekInteraction?: (phase: string, input: string, target: number, pointerTarget?: number) => void;
  onRate: (r: number) => void;
  onMute: () => void;
  onVolume: (v: number) => void;
  onFullscreen: () => void;
  onNext?: () => void;
};

const formatClock = (s: number) => fmtTime(Math.max(0, s || 0)).padStart(5, "0");

export default function PlayerControls({
  paused, clock, duration, buffered = 0, rate, muted, volume, fullscreen = false, dockInset = 0,
  visible = true, seekEnabled = true, seekKey, nextDisabled = false, nextTitle = "下一个", onToggle, onSeek, onSeekInteraction, onRate, onMute, onVolume, onFullscreen, onNext,
}: Props) {
  const [speedOpen, setSpeedOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const clockTime = useSyncExternalStore(clock.subscribe, clock.getSnapshot, clock.getSnapshot);
  const seek = useSeekInput({ time: clockTime, duration, enabled: seekEnabled, resetKey: seekKey, onInteraction: onSeekInteraction,
    onSeek: (target, input) => onSeek(target, `desktop_${input}`) });
  const pct = duration ? Math.min(100, (seek.time / duration) * 100) : 0;

  useEffect(() => {
    if (!speedOpen) return;
    const frame = requestAnimationFrame(() => boxRef.current?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]')?.focus());
    const outside = (e: PointerEvent) => { if (!boxRef.current?.contains(e.target as Node)) { setSpeedOpen(false); } };
    document.addEventListener("pointerdown", outside);
    return () => { cancelAnimationFrame(frame); document.removeEventListener("pointerdown", outside); };
  }, [speedOpen]);

  return (
    <div ref={boxRef} className={`desktop-controls ${fullscreen ? "is-fullscreen" : ""} ${visible ? "" : "is-hidden"}`}
      style={{ right: dockInset, transition: "right .3s cubic-bezier(.2,0,0,1)" }}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={event => {
        // Native button activation must not also toggle Feed's playback shortcut.
        if ([" ", "Enter"].includes(event.key) && (event.target as HTMLElement).closest("button")) event.stopPropagation();
      }}>
      {/* is-scrubbing：共享层 useSeekInput 的 scrub 仲裁态（B2 追加）。
          静默性口径（用户 2026-11-19 产品原则）：独占锁不产生任何可见
          提示——此类名只作宿主状态钩子（DOM/诊断可读），不挂视觉样式。 */}
      <div className={`desktop-seek ${seekEnabled ? "is-seekable" : ""} ${seek.scrubbing ? "is-scrubbing" : ""}`}>
        <div className="desktop-seek-track">
          <span className="desktop-seek-buffer" style={{ width: `${Math.min(1, buffered) * 100}%` }} />
          <span className="desktop-seek-played" style={{ width: `${pct}%` }} />
        </div>
        <Input aria-label="播放进度" type="range" {...seek.inputProps} />
      </div>

      <div className="desktop-control-row">
        <Button className="player-control primary-play" aria-label={paused ? "播放" : "暂停"} data-tooltip={paused ? "播放 Space" : "暂停 Space"} onClick={onToggle}>
          {paused ? <IPlayF size={19} /> : <IPauseF size={18} />}
        </Button>
        {onNext && (
          <Button className="player-control" aria-label={nextTitle} data-tooltip={nextTitle} disabled={nextDisabled} onClick={onNext}>
            <INext size={18} strokeWidth={1.7} />
          </Button>
        )}
        <span className="player-timecode"><span>{formatClock(seek.time)}</span><span className="player-time-separator">/</span>{formatClock(duration)}</span>
        <div className="player-control-spacer" />
        <div className="player-speed-slot">
          <Button className={`player-control player-speed ${rate !== 1 ? "is-on" : ""}`} aria-label="倍速" aria-haspopup="menu" aria-expanded={speedOpen}
            data-tooltip="播放速度" onClick={() => setSpeedOpen((v) => !v)}>
            {Number.isInteger(rate) ? rate.toFixed(1) : rate}x
          </Button>
          {speedOpen && (
            <div className="player-speed-menu" role="menu" aria-label="播放速度" onKeyDownCapture={event => {
              const entries = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
              const index = entries.indexOf(document.activeElement as HTMLButtonElement);
              if (event.key === "Escape") {
                event.preventDefault(); event.stopPropagation(); setSpeedOpen(false);
                boxRef.current?.querySelector<HTMLButtonElement>('.player-speed')?.focus();
              } else if (event.key === "Tab") {
                setSpeedOpen(false);
                boxRef.current?.querySelector<HTMLButtonElement>('.player-speed')?.focus();
              } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                event.preventDefault(); event.stopPropagation();
                const next = event.key === "Home" ? 0 : event.key === "End" ? entries.length - 1
                  : (index + (event.key === "ArrowDown" ? 1 : -1) + entries.length) % entries.length;
                entries[next]?.focus();
              }
            }}>
              <span className="player-menu-title">播放速度</span>
              {[0.5, 0.75, 1, 1.25, 1.5, 2].map((v) => (
                <Button key={v} role="menuitemradio" aria-checked={rate === v} onClick={() => {
                  onRate(v); setSpeedOpen(false);
                  boxRef.current?.querySelector<HTMLButtonElement>('.player-speed')?.focus();
                }}>
                  <span>{v === 1 ? "正常" : `${v}x`}</span>{rate === v && <ICheck size={14} />}
                </Button>
              ))}
            </div>
          )}
        </div>
        <div className="player-volume">
          <Button className="player-control" aria-label={muted ? "开启声音" : "静音"} data-tooltip="静音 M" onClick={onMute}>
            {muted || volume === 0 ? <IVolMute size={20} strokeWidth={1.6} /> : <IVol size={20} strokeWidth={1.6} />}
          </Button>
          <div className="player-volume-slider">
            <Input aria-label="音量" type="range" min={0} max={1} step={0.01} value={muted ? 0 : volume}
              style={{ "--fill": `${(muted ? 0 : volume) * 100}%` } as React.CSSProperties}
              onChange={(e) => onVolume(Number(e.target.value))} />
          </div>
        </div>
        
        
        <Button className="player-control" aria-label={fullscreen ? "退出全屏" : "全屏"} data-tooltip={fullscreen ? "退出全屏 Esc" : "全屏 F"} onClick={onFullscreen}>
          {fullscreen ? <ICompress size={19} strokeWidth={1.6} /> : <IExpand size={19} strokeWidth={1.6} />}
        </Button>
      </div>
    </div>
  );
}
