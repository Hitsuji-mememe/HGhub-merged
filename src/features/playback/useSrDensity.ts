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
 * 重置面：换源（srcKey 变）＋换线（lineEpoch 变）都重置——密度是线路
 * 相关量，旧线密度不许判新线。 */
import { useCallback, useEffect, useRef, useState } from "react";

export type SrDensity = {
  bitrateBps: number;
  fps?: number;
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
        density = {
          /* 码率以 playing rendition 的标称码率为准（同 rendition 口径）；
           * level 未给码率时回退分片实测中位数（旧夹具口径）。 */
          bitrateBps: level?.bitrate && level.bitrate > 0 ? level.bitrate : median,
          fps: fps && fps >= 10 && fps <= 120 ? fps : undefined,
          codec: level?.videoCodec || undefined,
          width: level?.width && level.width > 0 ? level.width : undefined,
          height: level?.height && level.height > 0 ? level.height : undefined,
          provisional: samples.length < 3,
          sampleCount: samples.length,
        };
      }
      return density;
    },
    reset(): void {
      samples = [];
      sampleLevel = -1;
      density = null;
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

  const ingest = useCallback((frag: SrFragSample, level: SrLevelInfo) => {
    /* 发布面只给 final 密度（fin-e P2-04 防护点）：provisional 值经
     * srDensityForTiering 收口为 null，hook 状态在满 3 片前保持
     * null——两播放面（VideoSurface/Player）的判档/facts/fps 消费
     * 全部经本状态，自动继承防护，不必逐面改。 */
    const next = srDensityForTiering(samplerRef.current?.ingest(frag, level) ?? null) ?? null;
    setDensity(prev => (prev?.bitrateBps === next?.bitrateBps && prev?.fps === next?.fps && prev?.codec === next?.codec && prev?.width === next?.width && prev?.height === next?.height && prev?.provisional === next?.provisional && prev?.sampleCount === next?.sampleCount ? prev : next));
  }, []);

  const reset = useCallback(() => {
    samplerRef.current?.reset();
    setDensity(null);
  }, []);

  return { density, ingest, reset };
}
