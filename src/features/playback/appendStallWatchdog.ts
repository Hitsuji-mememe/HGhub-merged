/* ── 起播 append 卡死看门狗（2026-11-18 收官批 F 项，P0） ──
 * 真机证据（playback-stall-evidence-20261118-1327）：某些 App 会话里
 * manifest 与分片下载全部成功（FragLoaded 有），但 buffer_appended /
 * FragBuffered / playing 全零、心跳 buffered 恒空——append 链根本没启动
 * 就无声停滞，且整场会话所有视频同坏；另一些会话全程正常（按会话发作）。
 *
 * 本看门狗只认这一个签名：首个 FragLoaded 到达后 timeoutMs 内仍无任何
 * buffered 且未 playing → 判卡死，回调 onStall（调用方负责重建/降级）。
 * 慢网（FragLoaded 都没来）永不触发——没有分片就无从判断 append 死活。
 * 时钟可注入，供断言以假时钟/假事件序列验证三段逻辑。 */

export type StallClock = {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

const systemClock: StallClock = {
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (handle) => window.clearTimeout(handle as number),
};

export class AppendStallWatchdog {
  private timer: unknown = null;
  private armed = false;
  private cleared = false;
  private disposed = false;

  constructor(private opts: {
    /** 卡死判定窗口：首个 FragLoaded 后多久仍无 buffered 算停滞。 */
    timeoutMs?: number;
    clock?: StallClock;
    /** 到点复查：已有可播缓冲则不算卡死（事件可能漏报）。 */
    hasBuffered: () => boolean;
    isPlaying: () => boolean;
    onStall: () => void;
  }) {}

  private get clock(): StallClock {
    return this.opts.clock ?? systemClock;
  }

  /** 首个完整/部分分片加载完成时调用；只有第一次会布防。 */
  fragLoaded(): void {
    if (this.disposed || this.cleared || this.armed) return;
    this.armed = true;
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      if (this.disposed || this.cleared) return;
      if (this.opts.hasBuffered() || this.opts.isPlaying()) {
        this.cleared = true;
        return;
      }
      this.opts.onStall();
    }, this.opts.timeoutMs ?? 4000);
  }

  /** 分片已进入缓冲（FragBuffered / SourceBuffer updateend）——本源已活。 */
  buffered(): void {
    this.clear();
  }

  /** 已出画播放——本源已活。 */
  playing(): void {
    this.clear();
  }

  private clear(): void {
    this.cleared = true;
    if (this.timer != null) {
      this.clock.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer != null) {
      this.clock.clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
