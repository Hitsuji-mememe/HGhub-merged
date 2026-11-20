/**
 * 外部源选集（Muse 2026-11-20 fix334 结构批 L2／G3，设计 §3.2）。
 *
 * 轻量选集组件：只服务外部源详情（SourceBrowse／Search 外部详情
 * 两宿主），数据是 episodes.ts 的 EpisodeChoice（字符串 externalId
 * ＋自由文本 label）。原生 feed/Panels.EpisodesPanel 的数字 ep_num
 * 形状不合、不复用也不改动它（Feed 是最高风险面，不为外部源动）。
 *
 * 视觉规格照 Panels：每行 5、热区 44px（h-11）、当前集高亮、
 * >30 集按 30 集分段（初始段落在当前集）、正/倒序切换。
 *
 * 形态：详情区内嵌可展开段——收起时只一行（选集入口＋共 N 集＋
 * 当前集）；展开期间经 registerOverlayBack 登记返回消费（与宿主
 * 详情层同口径，fix331/gesture-precedence 既有模式）：back 先收
 * 起选集、再关详情，防手势落穿。点中即播并收起（宿主 onPick 负责
 * 换流）；当前集重复点按只收起、不重取流。
 */
import { Button } from "../../shared/ui/ios/controls";
import { useEffect, useState } from "react";
import { registerOverlayBack } from "../../shared/lib/back";
import { IChevR, IClose } from "../../shared/ui/icons";
import type { EpisodeChoice } from "./episodes.ts";

const RANGE = 30;

export function EpisodePicker({ choices, currentKey, onPick, onClose }: {
  choices: EpisodeChoice[];
  currentKey: string;
  onPick: (choice: EpisodeChoice) => void;
  onClose?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [asc, setAsc] = useState(true);
  const curIdx = Math.max(0, choices.findIndex((c) => c.key === currentKey));
  const rangeCount = Math.ceil(choices.length / RANGE);
  const [range, setRange] = useState(() => Math.floor(curIdx / RANGE));

  const collapse = () => { setOpen(false); onClose?.(); };
  /* 展开期间登记返回消费：最新登记最先消费（back.ts 逆序），故
   * back 先收起本段、宿主详情层的登记随后才轮到。 */
  useEffect(() => {
    if (!open) return undefined;
    return registerOverlayBack(() => { setOpen(false); onClose?.(); return true; });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open ]);

  if (!open) {
    return (
      <div className="mt-3">
        <Button onClick={() => { setRange(Math.floor(curIdx / RANGE)); setOpen(true); }} aria-expanded={false}
          className="w-full h-11 px-3 rounded-(--r-sm) bg-s3 flex items-center gap-2 pressable">
          <span className="text-[13px] font-semibold text-on">选集</span>
          <span className="text-[12px] text-mut">共 {choices.length} 集</span>
          <span className="ml-auto min-w-0 truncate text-[12px] text-mut">当前：{choices[curIdx]?.label}</span>
          <IChevR size={14} className="shrink-0 text-mut" style={{ transform: "rotate(90deg)" }} />
        </Button>
      </div>
    );
  }

  const ranged = rangeCount > 1 ? choices.slice(range * RANGE, range * RANGE + RANGE) : choices;
  const list = asc ? ranged : [...ranged].reverse();
  return (
    <div className="mt-3">
      <div className="flex items-center gap-2 pb-2">
        <span className="text-[14px] font-bold text-on">选集</span>
        <span className="text-[12px] text-mut">共 {choices.length} 集</span>
        <Button onClick={() => setAsc((v) => !v)} className="ml-auto text-[12px] text-primary pressable">{asc ? "倒序" : "正序"}</Button>
        <Button onClick={collapse} aria-label="关闭选集" className="w-8 h-8 min-h-0 rounded-full bg-s3 flex items-center justify-center text-mut pressable">
          <IClose size={13} />
        </Button>
      </div>
      {rangeCount > 1 && (
        <div className="flex gap-1.5 pb-2 overflow-x-auto no-bar">
          {Array.from({ length: rangeCount }, (_, i) => (
            <Button key={i} onClick={() => setRange(i)} aria-pressed={range === i}
              className={`shrink-0 h-8 px-3 rounded-full text-[12px] font-semibold pressable ${range === i ? "bg-primary text-on-primary" : "bg-s3 text-on/70"}`}>
              {i * RANGE + 1}–{Math.min(choices.length, (i + 1) * RANGE)}
            </Button>
          ))}
        </div>
      )}
      <div className="grid grid-cols-5 gap-2">
        {list.map((c) => (
          <Button key={c.key} aria-current={c.key === currentKey ? "true" : undefined} title={c.label}
            onClick={() => { if (c.key !== currentKey) onPick(c); collapse(); }}
            className={`h-11 px-1 overflow-hidden rounded-(--r-sm) text-[12px] font-semibold pressable ${c.key === currentKey ? "bg-primary text-on-primary" : "bg-s3 text-on/80"}`}>
            {c.label}
          </Button>
        ))}
      </div>
    </div>
  );
}
