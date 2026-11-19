/* ── 超分密度共享采样（Muse 2026-11-19 根治包，audit6 P0-A 第 2 层）──
 * 判档输入此前双实现漂移：VideoSurface 取前 3 个完整分片的中位数码率
 * ＋level 的 frameRate＋videoCodec；Player 用首个样本锁定、无 codec——
 * 同一 effectiveSrMode 纯函数、两套口径，Feed 与帖子判档不可比。
 * 现收敛为一份：纯采样器 createSrDensitySampler（可单测）＋ hook 包装。
 * 口径以 VideoSurface 现行为准：同 level 前 3 片码率中位数；ABR 中途
 * 换 level 时旧样本作废重采；fps 只认 10–120 合理区间。
 * 重置面：换源（srcKey 变）＋换线（lineEpoch 变）都重置——密度是线路
 * 相关量，旧线密度不许判新线。 */
import { useCallback, useEffect, useRef, useState } from "react";

export type SrDensity = { bitrateBps: number; fps?: number; codec?: string };

export type SrFragSample = {
  loaded: number;
  duration: number;
  level: number;
};

export type SrLevelInfo = { frameRate?: number; videoCodec?: string } | undefined;

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
        const median = sorted[Math.floor(sorted.length / 2)];
        const fps = level?.frameRate;
        density = {
          bitrateBps: median,
          fps: fps && fps >= 10 && fps <= 120 ? fps : undefined,
          codec: level?.videoCodec || undefined,
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
    const next = samplerRef.current?.ingest(frag, level) ?? null;
    setDensity(prev => (prev?.bitrateBps === next?.bitrateBps && prev?.fps === next?.fps && prev?.codec === next?.codec ? prev : next));
  }, []);

  const reset = useCallback(() => {
    samplerRef.current?.reset();
    setDensity(null);
  }, []);

  return { density, ingest, reset };
}
