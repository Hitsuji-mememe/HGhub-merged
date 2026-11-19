/**
 * 超分画布选引擎包装（Muse 2026-11-19，fix2 超分换代）。
 *
 * VideoSurface / Player 只挂这一个组件，引擎选择收敛在此：
 *  - 探针 v2 机器门全过（摄入路径可用＋720p 全链成本 < 帧预算）
 *    且自动档为 natural/crisp → WebGpuSrCanvas（Anime4K 模型超分）；
 *  - 其余一切情况（探针未过/未完成、风格档 cinema/anime_*、用户关）
 *    → SuperResCanvas（现行 WebGL 锐化管线，即回退层）。
 * WebGPU 引擎一旦死亡（Device Lost/成本停档），本会话永久回退，
 * 不再重试（webgpuSr 的旁路纪律）。两条管线永不同时挂载、不叠加。
 * 画质采纳门的同帧对比证据在 fix2 报告与存档中（夹具实测）；设备
 * 侧的最终启用以探针 v2 在该设备上的实测为准——过不了自动回退，
 * 零用户操作。
 */

import React, { useEffect, useState } from "react";
import type { SuperResMode } from "../../shared/model/store";
import { getSrProbeResult, runSrProbe } from "../../shared/diagnostics/gpuProbe";
import SuperResCanvas from "./SuperResCanvas";
import WebGpuSrCanvas from "./WebGpuSrCanvas";

type Props = {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  mode: SuperResMode;
  active?: boolean;
  ready?: boolean;
  fit?: "contain" | "cover";
  srcKey?: string;
  fps?: number;
  onFallbackChange?: (useSvgFallback: boolean) => void;
  onActiveModeChange?: (mode: SuperResMode) => void;
  /** 实际管线是否为 WebGPU（audit6 P0-A 第 2 层呈现管线标识用）。 */
  onPipelineChange?: (webgpuEngaged: boolean) => void;
  onTrace?: (event: string, data?: Record<string, unknown>) => void;
};

/* 画质采纳门（用户 2026-11-19 01:35 亲定：三条全过才转默认）：
 * 夹具同帧对比（160→320，证据在 fix2 存档 sr-quality/）——文字/边缘
 * 提升肉眼可辨（标题带 SSIM +0.0105、锐度 +73%），但纹理细节未达
 * 同级、lineart 带 PSNR 反降 0.31dB，属「部分过」；且帧预算与稳定
 * 性只能在真机探针 v2 终判。
 * 翻转（整改 B17-5，用户 2026-11-19 拍板）：默认开启「探针门全过
 * 才呈现」的条件式默认——呈现仍受探针门 v2 约束（gatesPass＋
 * recommendedPath＋mode∈{natural,crisp}），门不过自动回退 WebGL
 * 锐化管线，零用户操作；前置四修 B17-1..4（探针等待对齐、档位
 * 回报、死亡闩锁全局化、降级排除快速域）已先行落地。 */
export const SR_MODEL_DEFAULT_ENABLED = true;

/** 超分引擎版本（Muse 2026-11-19 根治包，audit6 P0-A 第 3 层）：探针
 * 持久化键的组成部分——引擎代码变更时手动 +1，旧探针结果自动失效。 */
export const SR_ENGINE_VERSION = 1;

/* 会话级闩锁：WebGPU 引擎死过一次，本会话所有播放面都不再试。 */
let webgpuSessionDead = false;

/* 死亡订阅（整改 B17-3）：旧实现只有触发死亡的那个实例 setState
 * 退出，其余已挂载面不知情、继续跑 WebGPU。现死亡经
 * noteWebgpuSessionDeath 统一置位并通知全部订阅者，各实例自行
 * 重渲染回落 SuperResCanvas。 */
const webgpuDeathListeners = new Set<() => void>();
export function subscribeWebgpuSessionDeath(fn: () => void): () => void {
  webgpuDeathListeners.add(fn);
  return () => { webgpuDeathListeners.delete(fn); };
}
export function noteWebgpuSessionDeath(): void {
  if (webgpuSessionDead) return;
  webgpuSessionDead = true;
  for (const fn of [...webgpuDeathListeners]) {
    try { fn(); } catch { /* 订阅者异常不外溢 */ }
  }
}

export default function SrCanvas(props: Props) {
  const [probeReady, setProbeReady] = useState(() => getSrProbeResult() !== null);
  const [, setDeadTick] = useState(0);

  /* 任一播放面的引擎死亡 → 全部已挂载面退出 WebGPU（整改 B17-3）。 */
  useEffect(() => subscribeWebgpuSessionDeath(() => setDeadTick((v) => v + 1)), []);

  /* 探针等待对齐（整改 B17-1）：旧实现只轮询缓存 ~40s（n>20）就
   * 放弃，而探针预算是 idle 调度＋最长 90s 以上，且无人替先挂载的
   * 面调 runSrProbe 时缓存永远为空——先挂载的播放面永远等不到。
   * 现事件驱动为主：挂载即调 runSrProbe()（幂等、共享 inflight、
   * 持久化命中直接 resolve），完成即补接管；长轮询兜底上限延至
   * ~150s（n>75），覆盖探针全程预算。 */
  useEffect(() => {
    if (probeReady) return;
    let cancelled = false;
    void runSrProbe().then(() => {
      if (!cancelled) setProbeReady(getSrProbeResult() !== null);
    });
    let n = 0;
    const timer = setInterval(() => {
      n += 1;
      if (getSrProbeResult() !== null || n > 75) {
        setProbeReady(getSrProbeResult() !== null);
        clearInterval(timer);
      }
    }, 2000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [probeReady]);

  const probe = getSrProbeResult();
  const engaged =
    SR_MODEL_DEFAULT_ENABLED &&
    !webgpuSessionDead &&
    probeReady &&
    probe?.gatesPass === true &&
    !!probe.recommendedPath &&
    (props.mode === "natural" || props.mode === "crisp");

  useEffect(() => { props.onPipelineChange?.(engaged); }, [engaged, props]);

  if (engaged) {
    return (
      <WebGpuSrCanvas
        videoRef={props.videoRef}
        mode={props.mode}
        active={props.active}
        ready={props.ready}
        fit={props.fit}
        srcKey={props.srcKey}
        fps={props.fps}
        onActiveModeChange={props.onActiveModeChange}
        onTrace={props.onTrace}
        onEngineDead={() => {
          noteWebgpuSessionDeath();
          props.onTrace?.("sr.webgpu_dead", {});
        }}
      />
    );
  }
  return <SuperResCanvas {...props} />;
}

/* 供测试/诊断读取的会话闩锁状态。 */
export function isWebgpuSessionDead(): boolean {
  return webgpuSessionDead;
}

/** 仅测试夹具用：闩锁是进程级单向状态，夹具需在场景间隔离复位；
 * 生产路径不调用（与 mediaTransport 的同名口径一致）。 */
export function resetWebgpuSessionDeathForTests(): void {
  webgpuSessionDead = false;
}
