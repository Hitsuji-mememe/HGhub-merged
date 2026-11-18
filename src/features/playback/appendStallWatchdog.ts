/* ── 起播 append 卡死看门狗（2026-11-18 收官批 F 项，P0） ──
 * 真机证据（playback-stall-evidence-20261118-1327）：某些 App 会话里
 * manifest 与分片下载全部成功（FragLoaded 有），但 buffer_appended /
 * FragBuffered / playing 全零、心跳 buffered 恒空——append 链根本没启动
 * 就无声停滞，且整场会话所有视频同坏；另一些会话全程正常（按会话发作）。
 *
 * 本看门狗只认这一个签名：首个 FragLoaded 到达后 timeoutMs 内仍无任何
 * buffered 且未 playing → 判卡死，回调 onStall（调用方负责重建/降级）。
 * 慢网（FragLoaded 都没来）永不触发——没有分片就无从判断 append 死活。
 * 时钟可注入，供断言以假时钟/假事件序列验证三段逻辑。
 *
 * 四状态判死（2026-11-18 晚 GPT 全量审计整改 1）：原判据只有 buffered/
 * playing 两个信号，「FragLoaded 后 append 合法地慢」与「真死锁」分不开。
 * 现接入 SourceBuffer append 生命周期信号（BUFFER_APPENDING/APPENDED），
 * 到点先分类再判死：
 *   not-started       —— append 从未开始（队列没动）：真停滞，判死；
 *   append-hung       —— append 已开始、一个宽限窗后仍未结束：判死；
 *   appended-no-buffer—— append 已结束但 buffered 仍为空：判死；
 *   （append 正在处理且未超时 → 不判死，自动延长一个宽限窗再复查。）
 * 「buffered 已增长但不 playing」由第二臂接管（2026-11-18 晚复审批，
 * GPT §4.2 裁定成立）：此前头注释声称活动层 play 重试负责，实际活动层
 * 只在页面激活/意图变化时重播、无超时守候——该状态曾无超时负责人。
 * 现 buffered 首达后转入出画守候：窗口内 playing 不来且播放意愿在
 * （shouldEscalate 门控，用户暂停不判死）→ 以 buffered-no-play 判死，
 * 与 append 臂共用重建/降级链。 */

export type StallClock = {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

export type AppendStallState = "not-started" | "append-hung" | "appended-no-buffer" | "buffered-no-play";

const systemClock: StallClock = {
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (handle) => window.clearTimeout(handle as number),
};

export class AppendStallWatchdog {
  private timer: unknown = null;
  private playTimer: unknown = null;
  private armed = false;
  private cleared = false;
  private disposed = false;
  private appendSeen = false;
  private appendInFlight = false;
  private extended = false;
  private bufferedSeen = false;

  constructor(private opts: {
    /** 卡死判定窗口：首个 FragLoaded 后多久仍无 buffered 算停滞。 */
    timeoutMs?: number;
    clock?: StallClock;
    /** 到点复查：已有可播缓冲则不算卡死（事件可能漏报）。 */
    hasBuffered: () => boolean;
    isPlaying: () => boolean;
    /** 出画臂判死前的意愿门控：用户已暂停/不想播时不判死（缺省放行）。 */
    shouldEscalate?: () => boolean;
    onStall: (state: AppendStallState) => void;
  }) {}

  private get clock(): StallClock {
    return this.opts.clock ?? systemClock;
  }

  /** 首个完整/部分分片加载完成时调用；只有第一次会布防。 */
  fragLoaded(): void {
    if (this.disposed || this.cleared || this.armed) return;
    this.armed = true;
    this.armTimer();
  }

  private armTimer(): void {
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      if (this.disposed || this.cleared) return;
      if (this.opts.hasBuffered() || this.opts.isPlaying()) {
        this.cleared = true;
        return;
      }
      /* append 正在处理且还没给过宽限：先延长一个窗口再判——合法慢
       * append 不该在首窗被误杀；宽限后仍在途才算 append-hung。 */
      if (this.appendInFlight && !this.extended) {
        this.extended = true;
        this.armTimer();
        return;
      }
      const state: AppendStallState = !this.appendSeen
        ? "not-started"
        : this.appendInFlight
          ? "append-hung"
          : "appended-no-buffer";
      this.opts.onStall(state);
    }, this.opts.timeoutMs ?? 4000);
  }

  /** SourceBuffer 开始 append（BUFFER_APPENDING）。 */
  appendStarted(): void {
    this.appendSeen = true;
    this.appendInFlight = true;
  }

  /** SourceBuffer 一次 append 结束（BUFFER_APPENDED）。 */
  appendEnded(): void {
    this.appendInFlight = false;
  }

  /** 分片已进入缓冲（FragBuffered / SourceBuffer updateend）：append 臂
   * 达成使命撤防，转入出画守候（第二臂）——playing 在窗口内不来才判死。 */
  buffered(): void {
    if (this.disposed || this.cleared || this.bufferedSeen) return;
    this.bufferedSeen = true;
    if (this.timer != null) {
      this.clock.clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.opts.isPlaying()) {
      this.clear();
      return;
    }
    this.playTimer = this.clock.setTimeout(() => {
      this.playTimer = null;
      if (this.disposed || this.cleared) return;
      if (this.opts.isPlaying() || !this.opts.hasBuffered()) {
        this.cleared = true;
        return;
      }
      if (this.opts.shouldEscalate && !this.opts.shouldEscalate()) {
        this.cleared = true;
        return;
      }
      this.opts.onStall("buffered-no-play");
    }, this.opts.timeoutMs ?? 4000);
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
    if (this.playTimer != null) {
      this.clock.clearTimeout(this.playTimer);
      this.playTimer = null;
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer != null) {
      this.clock.clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.playTimer != null) {
      this.clock.clearTimeout(this.playTimer);
      this.playTimer = null;
    }
  }
}
