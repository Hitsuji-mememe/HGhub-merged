import { Button, Form, Image, Input } from "../../shared/ui/ios/controls";
import { Loader } from "../../shared/ui/ios/effects";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, fmt, cover as imageCover } from "../../shared/api/api";
import { handleArticleClick, sanitizeHtml } from "../../shared/lib/html";
import type { Episode } from "../../shared/api/types";
import { useStore } from "../../shared/model/store";
import { copyText } from "../../shared/lib/clipboard";
import { Avatar, Empty } from "../../shared/ui/ui";
import { IClose } from "../../shared/ui/icons";

/* ================= 选集 ================= */
export function EpisodesPanel({ episodes, current, onPick, onClose, bare = false }: {
  videoId: number; episodes: Episode[]; current: number; onPick: (ep: number) => void; onClose: () => void;
  /** 嵌在双栏抽屉里时，隐藏自带的标题栏 */
  bare?: boolean;
}) {
  const [asc, setAsc] = useState(true);
  /* 长剧分组（蓝图 P2）：每 30 集一段，段签横排切换；初始段落在当前集。
     网格每行 5、热区 44px（原每行 4 / 40px 不达触控红线）。 */
  const RANGE = 30;
  const rangeCount = Math.ceil(episodes.length / RANGE);
  const curIdx = episodes.findIndex((e) => e.ep_num === current);
  const [range, setRange] = useState(() => (curIdx >= 0 ? Math.floor(curIdx / RANGE) : 0));
  const ranged = rangeCount > 1 ? episodes.slice(range * RANGE, range * RANGE + RANGE) : episodes;
  const list = asc ? ranged : [...ranged].reverse();
  return (
    <div className="flex flex-col h-full">
      {bare ? (
        <div className="shrink-0 flex items-center gap-2 px-4 pb-2">
          <span className="text-[12px] text-mut">共 {episodes.length} 集</span>
          <Button onClick={() => setAsc((v) => !v)} className="ml-auto text-[12px] text-primary pressable">{asc ? "倒序" : "正序"}</Button>
        </div>
      ) : (
        <div className="shrink-0 flex items-center gap-2 px-4 h-12">
          <span className="text-[14px] font-bold text-on">选集</span>
          <span className="text-[12px] text-mut">共 {episodes.length} 集</span>
          <Button onClick={() => setAsc((v) => !v)} className="ml-auto text-[12px] text-primary pressable">{asc ? "倒序" : "正序"}</Button>
          <Button onClick={onClose} aria-label="关闭" className="w-8 h-8 min-h-0 rounded-full bg-s3 flex items-center justify-center text-mut pressable">
            <IClose size={13} />
          </Button>
        </div>
      )}
      {rangeCount > 1 && (
        <div className="shrink-0 flex gap-1.5 px-4 pb-2 overflow-x-auto no-bar">
          {Array.from({ length: rangeCount }, (_, i) => (
            <Button key={i} onClick={() => setRange(i)} aria-pressed={range === i}
              className={`shrink-0 h-8 px-3 rounded-full text-[12px] font-semibold pressable ${range === i ? "bg-primary text-on-primary" : "bg-s3 text-on/70"}`}>
              {i * RANGE + 1}–{Math.min(episodes.length, (i + 1) * RANGE)}
            </Button>
          ))}
        </div>
      )}
      <div className="flex-1 scroll-y px-4 pb-4">
        <div className="grid grid-cols-5 gap-2">
          {list.map((e) => (
            <Button key={e.ep_num} aria-current={e.ep_num === current ? "true" : undefined} onClick={() => onPick(e.ep_num)}
              className={`h-11 rounded-(--r-sm) text-[13px] font-semibold pressable ${e.ep_num === current ? "bg-primary text-on-primary" : "bg-s3 text-on/80"}`}>
              {e.ep_num}
            </Button>
          ))}
        </div>
        {!episodes.length && <div className="text-center text-[12px] text-dim py-8">暂无剧集</div>}
      </div>
    </div>
  );
}

/* ================= 评论 ================= */
export function ArticlePanel({ title, html, cover, hot, onClose }: {
  title: string; html: string; cover?: string; hot?: number; onClose: () => void;
}) {
  const { toast, strictSecurity } = useStore();
  const safeHtml = useMemo(() => sanitizeHtml(html), [html, strictSecurity]);
  const openSafeLink = (url: string) => {
    api.openUrl(url).catch(() => {
      copyText(url).then(() => toast("链接已复制", "ok")).catch(() => toast("复制失败", "info"));
    });
  };
  return (
    <div className="flex flex-col h-full">
      <div className="shrink-0 flex items-center gap-2 px-4 h-12">
        <span className="text-[14px] font-bold text-on">图文详情</span>
        {hot ? <span className="text-[12px] text-mut">{fmt(hot)} 热度</span> : null}
        <Button onClick={onClose} aria-label="关闭" className="ml-auto w-8 h-8 min-h-0 rounded-full bg-s3 flex items-center justify-center text-mut pressable">
          <IClose size={13} />
        </Button>
      </div>
      <div className="flex-1 scroll-y px-4 pb-6">
        {cover && <Image src={imageCover(cover)} alt="" className="w-full rounded-(--r-md) mb-3 object-cover" />}
        <h2 className="text-[16px] font-bold text-on leading-snug">{title}</h2>
        <div className="article-body mt-3" onClick={(e) => handleArticleClick(e, openSafeLink)} dangerouslySetInnerHTML={{ __html: safeHtml }} />
        {!safeHtml && <p className="text-[13px] text-dim mt-4">这篇内容没有正文，可能只有图片或视频。</p>}
      </div>
    </div>
  );
}
