/**
 * 分类总览分区可见性（Muse 2026-11-19 fix330/ui-fixes）：用户裁定
 * 「某分区内容为空时整区隐藏（含视频区）」。隐藏的充要口径只有一
 * 个：该区已尝试加载（attempted）、不在加载中、无错误、且条目数
 * 为 0。加载中/未尝试/出错一律保持可见——加载中隐藏会让首屏闪
 * 空，出错隐藏会吞掉错误态与重试入口（诚实态优先于整洁）。
 * 可用性提示类区块（blocked 诚实提示、未接线提示）不是内容区，
 * 不走本谓词、恒可见（源线既定口径）。
 */
export function contentSectionVisible(input: {
  attempted: boolean;
  loading: boolean;
  hasError: boolean;
  count: number;
}): boolean {
  return !(input.attempted && !input.loading && !input.hasError && input.count === 0);
}
