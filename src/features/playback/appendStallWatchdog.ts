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
 * 与 append 臂共用重建/降级链。
 *
 * 生命周期收口（Muse 2026-11-19 根治包，audit5 条 1）：旧实现把
 * 「已出画/已判死」的终局与「意愿不在、暂不适用」的挂起共用同一个
 * cleared latch——出画守候窗内用户暂停一次，看门狗即永久退役，恢复
 * 播放后再卡死无人检出。现拆两态：终局（retired）只许由已出画或
 * 判死已交付 onStall 进入；意愿门控命中走挂起（suspended），不判死、
 * 不退役，意愿恢复时经 resume() 重新起守候窗。append 臂到点复查
 * hasBuffered 命中时转交出画守候臂，不再直接退役。 */

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
  /** 终局态：已出画或判死已交付后为 true，此后永不复活（本源已定性）。 */
  private retired = false;
  /** 挂起态：意愿门控命中时进入——不判死、不退役，等 resume() 复查。 */
  private suspended = false;
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
    /** 判死前的意愿门控（两臂共用，整改 B10）：用户已暂停/不想播时
     * 不判死、转挂起（缺省放行）。 */
    shouldEscalate?: () => boolean;
    onStall: (state: AppendStallState) => void;
    /** 判死被意愿门控挂起时的留痕通道（fix322/play）：门控吞掉判死
     * 不得无声——3.2.1 真机出现「用户可见卡死但诊断无 append_stall」
     * 的组合，门后无痕即无从定性。只记账、不改变判死行为：状态
     * 参数为若未被门控本将交付 onStall 的判定。 */
    onGated?: (state: AppendStallState) => void;
  }) {}

  private get clock(): StallClock {
    return this.opts.clock ?? systemClock;
  }

  /** 首个完整/部分分片加载完成时调用；只有第一次会布防。 */
  fragLoaded(): void {
    if (this.disposed || this.retired || this.armed) return;
    this.armed = true;
    this.armTimer();
  }

  /** 意愿恢复时由活动层回调：挂起态重新起守候窗（已 buffered 走出画
   * 守候臂，未 buffered 走 append 臂）。终局/已布防时为无操作。 */
  resume(): void {
    if (this.disposed || this.retired || !this.suspended) return;
    this.suspended = false;
    if (this.bufferedSeen) this.armPlayTimer();
    else if (this.armed) this.armTimer();
  }

  /** 当前是否处于意愿挂起（供接线层/测试观测，不参与判死）。 */
  get isSuspended(): boolean {
    return this.suspended;
  }

  private armTimer(): void {
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      if (this.disposed || this.retired || this.suspended) return;
      if (this.opts.isPlaying()) {
        this.retire();
        return;
      }
      /* 事件漏报但缓冲实际已有：转交出画守候臂继续盯 playing，
       * 不许在此退役（旧实现直接 cleared，出画臂从未 engage）。 */
      if (this.opts.hasBuffered()) {
        this.buffered();
        return;
      }
      /* append 正在处理且还没给过宽限：先延长一个窗口再判——合法慢
       * append 不该在首窗被误杀；宽限后仍在途才算 append-hung。 */
      if (this.appendInFlight && !this.extended) {
        this.extended = true;
        this.armTimer();
        return;
      }
      /* 意愿门控（整改 B10）：append 臂与出画臂同态——意愿不在时
       * 挂起而非 retire。旧实现先 retire 再调 onStall，接线层意愿门
       * 把 onStall 吞掉后看门狗已永久退役，本源再卡死无人检出。
       * 挂起必须留痕（fix322/play）：经 onGated 记下被吞的判定。 */
      const state: AppendStallState = !this.appendSeen
        ? "not-started"
        : this.appendInFlight
          ? "append-hung"
          : "appended-no-buffer";
      if (this.opts.shouldEscalate && !this.opts.shouldEscalate()) {
        this.suspended = true;
        this.opts.onGated?.(state);
        return;
      }
      this.retire();
      this.opts.onStall(state);
    }, this.opts.timeoutMs ?? 4000);
  }

  private armPlayTimer(): void {
    if (this.playTimer != null) {
      this.clock.clearTimeout(this.playTimer);
      this.playTimer = null;
    }
    this.playTimer = this.clock.setTimeout(() => {
      this.playTimer = null;
      if (this.disposed || this.retired || this.suspended) return;
      if (this.opts.isPlaying()) {
        this.retire();
        return;
      }
      if (!this.opts.hasBuffered()) {
        /* 缓冲已消失：出画守候的前提不在，终局退出（无从判死）。 */
        this.retire();
        return;
      }
      if (this.opts.shouldEscalate && !this.opts.shouldEscalate()) {
        /* 意愿门控命中：挂起而非退役——用户恢复播放后 resume()
         * 必须还能把本臂重新拉起（audit5 条 1 的核心时序）。
         * 挂起留痕同 append 臂（fix322/play）。 */
        this.suspended = true;
        this.opts.onGated?.("buffered-no-play");
        return;
      }
      this.retire();
      this.opts.onStall("buffered-no-play");
    }, this.opts.timeoutMs ?? 4000);
  }

  private retire(): void {
    this.retired = true;
    this.suspended = false;
    if (this.timer != null) {
      this.clock.clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.playTimer != null) {
      this.clock.clearTimeout(this.playTimer);
      this.playTimer = null;
    }
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
    if (this.disposed || this.retired) return;
    if (this.bufferedSeen && !this.suspended) return;
    this.bufferedSeen = true;
    this.suspended = false;
    if (this.timer != null) {
      this.clock.clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.opts.isPlaying()) {
      this.retire();
      return;
    }
    this.armPlayTimer();
  }

  /** 已出画播放——本源已活（终局）。 */
  playing(): void {
    this.retire();
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
