/* ── 超分密度共享采样（Muse 2026-11-19 根治包，audit6 P0-A 第 2 层）──
 * 判档输入此前双实现漂移：VideoSurface 取前 3 个完整分片的中位数码率
 * ＋level 的 frameRate＋videoCodec；Player 用首个样本锁定、无 codec——
 * 同一 effectiveSrMode 纯函数、两套口径，Feed 与帖子判档不可比。
 * 现收敛为一份：纯采样器 createSrDensitySampler（可单测）＋ hook 包装。
 * 口径以 VideoSurface 现行为准：同 level 累计采样，满 3 片取 3 片码率
 * 中位数为 final 密度；未满 3 片时采样器返回的只是 provisional 值
 * （已采样本的上中位数，仅供诊断/测试观测），不许驱动判档（GPT
 * P2-04，Muse 2026-11-19 最终版 E 线）：hook 只发布 final 值，
 * srDensityForTiering 与 effectiveSrMode 的 density?.provisional
 * 守卫再兜一层。ABR 中途换 level 时旧样本作废重采；fps 只认
 * 10–120 合理区间。
 * 帧率双口径（2026-11-19 3.3.0批 SR 帧率回填线）：fps 恒为声明值
 * （level.frameRate）；声明缺失时内核 rVFC 实测（srFpsEstimate）定
 * 版后经 noteMeasuredFps 注入 measuredFps，两字段分开存放、分开
 * 消费（分离纪律见 srFpsEstimate 文件头与 effectiveSrMode）。
 * 重置面：换源（srcKey 变）＋换线（lineEpoch 变）都重置——密度是线路
 * 相关量，旧线密度不许判新线。 */
import { useCallback, useEffect, useRef, useState } from "react";

export type SrDensity = {
  bitrateBps: number;
  /** 声明帧率（主列表 FRAME-RATE → level.frameRate，10–120 过滤后）。
   * 关超分门与 SR 帧成本预算只认此值（回填线护栏 1）。 */
  fps?: number;
  /** rVFC 实测回填帧率（已保守吸附，srFpsEstimate）：仅声明缺失且
   * 实测已定版时存在，只供 crisp 判档门消费（effectiveSrMode 的
   * fpsKnownForCrisp），不许喂 bpp/off 门/帧预算。 */
  measuredFps?: number;
  /** 定版时的实测中值（未吸附），仅供诊断判读估计偏差。 */
  measuredRawFps?: number;
  /** 判档可用帧率的来源：declared＝声明值；measured＝实测回填。
   * 两者皆无时缺失。声明在时恒为 declared（实测不覆盖声明）。 */
  fpsSource?: "declared" | "measured";
  codec?: string;
  width?: number;
  height?: number;
  /** 未满 3 个完整分片时为 true：值未定版，不许驱动判档/降档。 */
  provisional: boolean;
  /** 当前 level 已采完整分片数（1–3）。 */
  sampleCount: number;
};

/** 判档入参收口（fin-e）：provisional 密度一律视为密度未知（返回
 * undefined），只有 final 密度可进 effectiveSrMode 的 bpp 判据。
 * 两播放面经 useSrDensity hook 消费本收口后的值，自动继承。 */
export function srDensityForTiering(density: SrDensity | null | undefined): SrDensity | undefined {
  return density && !density.provisional ? density : undefined;
}

export type SrFragSample = {
  loaded: number;
  duration: number;
  /** 采样身份 = 正在播放的 level（整改 B4：调用方传 playing level，
   * 不是分片自己的下载 level）。 */
  level: number;
};

/** 正在播放 level 的 rendition 信息（整改 B4）：码率/fps/codec/宽/高
 * 全部取同一 rendition，判档 bpp 的分子分母不再跨档拼凑。 */
export type SrLevelInfo = { frameRate?: number; videoCodec?: string; width?: number; height?: number; bitrate?: number } | undefined;

export function createSrDensitySampler() {
  let samples: number[] = [];
  let sampleLevel = -1;
  let density: SrDensity | null = null;
  /* 实测回填暂存（回填线）：估计器定版后经 noteMeasuredFps 注入；
   * density 尚未产出时先存着，ingest 产出时合并；声明 fps 一旦出现
   * 即以声明为准（fpsSource=declared），暂存值不再生效。 */
  let measured: { fps?: number; rawMedian?: number } | null = null;
  const withFpsFields = (base: SrDensity, declaredFps: number | undefined): SrDensity => {
    if (declaredFps !== undefined) {
      return { ...base, fps: declaredFps, measuredFps: undefined, measuredRawFps: undefined, fpsSource: "declared" };
    }
    if (measured?.fps !== undefined) {
      return { ...base, fps: undefined, measuredFps: measured.fps, measuredRawFps: measured.rawMedian, fpsSource: "measured" };
    }
    return { ...base, fps: undefined, measuredFps: undefined, measuredRawFps: undefined, fpsSource: undefined };
  };
  return {
    ingest(frag: SrFragSample, level: SrLevelInfo): SrDensity | null {
      if (!(frag.loaded > 0) || !(frag.duration > 0)) return density;
      if (sampleLevel !== frag.level) {
        sampleLevel = frag.level;
        samples = [];
      }
      if (samples.length < 3) {
        samples = [...samples, (frag.loaded * 8) / frag.duration];
        const sorted = [...samples].sort((a, b) => a - b);
        /* 未满 3 片时这是已采样本的上中位数（1 片＝该片值、2 片＝较大
         * 值），不是「前 3 片中位数」——仅作 provisional 观测值随
         * 返回对象带出，判档路径不得消费（见文件头 P2-04 口径）。 */
        const median = sorted[Math.floor(sorted.length / 2)];
        const fps = level?.frameRate;
        const declaredFps = fps && fps >= 10 && fps <= 120 ? fps : undefined;
        density = withFpsFields({
          /* 码率以 playing rendition 的标称码率为准（同 rendition 口径）；
           * level 未给码率时回退分片实测中位数（旧夹具口径）。 */
          bitrateBps: level?.bitrate && level.bitrate > 0 ? level.bitrate : median,
          codec: level?.videoCodec || undefined,
          width: level?.width && level.width > 0 ? level.width : undefined,
          height: level?.height && level.height > 0 ? level.height : undefined,
          provisional: samples.length < 3,
          sampleCount: samples.length,
        }, declaredFps);
      }
      return density;
    },
    /** 实测回填注入（内核 rVFC 估计器定版时调用一次）：fps 为已吸附
     * 值，定版为未知时 fps 缺失（只记 rawMedian 不产生回填）。声明
     * fps 已在 density 上时不覆盖、直接返回现值。 */
    noteMeasuredFps(fps: number | undefined, rawMedian: number | undefined): SrDensity | null {
      measured = { fps, rawMedian };
      if (density && density.fps === undefined) {
        density = withFpsFields({ ...density }, undefined);
      }
      return density;
    },
    reset(): void {
      samples = [];
      sampleLevel = -1;
      density = null;
      measured = null;
    },
    current(): SrDensity | null {
      return density;
    },
  };
}

export function useSrDensity(srcKey: string, lineEpoch: number) {
  const samplerRef = useRef<ReturnType<typeof createSrDensitySampler> | null>(null);
  if (!samplerRef.current) samplerRef.current = createSrDensitySampler();
  const [density, setDensity] = useState<SrDensity | null>(null);

  useEffect(() => {
    samplerRef.current?.reset();
    setDensity(null);
  }, [srcKey, lineEpoch]);

  const publish = useCallback((next: SrDensity | null) => {
    setDensity(prev => (prev?.bitrateBps === next?.bitrateBps && prev?.fps === next?.fps && prev?.measuredFps === next?.measuredFps && prev?.measuredRawFps === next?.measuredRawFps && prev?.fpsSource === next?.fpsSource && prev?.codec === next?.codec && prev?.width === next?.width && prev?.height === next?.height && prev?.provisional === next?.provisional && prev?.sampleCount === next?.sampleCount ? prev : next));
  }, []);

  const ingest = useCallback((frag: SrFragSample, level: SrLevelInfo) => {
    /* 发布面只给 final 密度（fin-e P2-04 防护点）：provisional 值经
     * srDensityForTiering 收口为 null，hook 状态在满 3 片前保持
     * null——两播放面（VideoSurface/Player）的判档/facts/fps 消费
     * 全部经本状态，自动继承防护，不必逐面改。 */
    publish(srDensityForTiering(samplerRef.current?.ingest(frag, level) ?? null) ?? null);
  }, [publish]);

  /* 实测回填发布（回填线）：与 ingest 同一发布面——回填只合并进
   * final 密度（provisional 期经 srDensityForTiering 同样收口为
   * null，不提前驱动判档）；估计器定版在起播数秒后，此时密度通常
   * 已 final，合并即触发两播放面渲染期重算判档（零重建切换）。 */
  const noteMeasuredFps = useCallback((fps: number | undefined, rawMedian: number | undefined) => {
    publish(srDensityForTiering(samplerRef.current?.noteMeasuredFps(fps, rawMedian) ?? null) ?? null);
  }, [publish]);

  const reset = useCallback(() => {
    samplerRef.current?.reset();
    setDensity(null);
  }, []);

  return { density, ingest, noteMeasuredFps, reset };
}
