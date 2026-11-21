import { Button } from "../../shared/ui/ios/controls";
import { useRef, useState } from "react";
import { useStore } from "../../shared/model/store";
import { ICheck } from "../../shared/ui/icons";
import { HISTORY_LONG_PRESS_MS, toggleHistorySelection, validHistorySelection } from "./searchHistoryState";

/** 搜索历史区（Muse 2026-11-21 fix3311/small-features，上游 #184
 * 拣选）：全局搜索（Search）与就地搜索（InplaceSearch）共用同一
 * 渲染与交互，不再各绘一份。常规态点按条目即打开搜索；长按一条
 * （HISTORY_LONG_PRESS_MS）进入多选态——条目变 aria-pressed 勾选
 * （复用 ios-filter-pill 既有选中样式＋勾选标记，与 TagBlockMenu
 * 多选同族），勾选后经动作条批量删除，取消或删完退出多选、恢复
 * 点按打开；「清空」全量入口保留。多选态下点按只切换勾选。
 * 选集只认当前历史里仍存在的条目（validHistorySelection 裁剪，
 * 仿 TagBlockMenu 的 validSelected）：历史被清空/变更后陈旧选集
 * 自动失效，不计数、不删除。长按计时在指针移动超 10px（滚动）、
 * 抬起、离开、取消时作废；长按触发后紧随的那次 click 被吞掉，
 * 不会误打开或误勾选。 */
export function SearchHistory({ onPick, titleClassName, clearClassName, chipsClassName, chipClassName }: {
  onPick: (h: string) => void;
  titleClassName: string;
  clearClassName: string;
  chipsClassName: string;
  chipClassName: string;
}) {
  const { searchHist, clearSearchHist, removeSearchHist } = useStore();
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const pressTimer = useRef<number | null>(null);
  const pressOrigin = useRef<{ x: number; y: number } | null>(null);
  const suppressClick = useRef(false);

  const validSelected = validHistorySelection(selected, searchHist);

  const clearTimer = () => {
    if (pressTimer.current !== null) { window.clearTimeout(pressTimer.current); pressTimer.current = null; }
  };
  const exitSelect = () => { setSelecting(false); setSelected([]); };
  const deleteSelected = () => {
    if (!validSelected.length) return;
    removeSearchHist(validSelected);
    exitSelect();
  };

  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <h2 className={titleClassName}>搜索历史</h2>
        {selecting ? (
          <Button onClick={exitSelect} className={clearClassName}>取消</Button>
        ) : (
          <Button onClick={clearSearchHist} className={clearClassName}>清空</Button>
        )}
      </div>
      <div className={`flex flex-wrap gap-2 ${chipsClassName}`}>
        {searchHist.map((h) => {
          const checked = selecting && validSelected.includes(h);
          return (
            <Button key={h}
              aria-pressed={selecting ? checked : undefined}
              className={chipClassName}
              onPointerDown={(e) => {
                if (selecting) return;
                pressOrigin.current = { x: e.clientX, y: e.clientY };
                clearTimer();
                pressTimer.current = window.setTimeout(() => {
                  pressTimer.current = null;
                  suppressClick.current = true;
                  /* 长按已触发但 click 未至（指针移出后抬起）时，
                   * 抑制标记须自行过期，不许吞掉下一次正常点按。 */
                  window.setTimeout(() => { suppressClick.current = false; }, 350);
                  setSelecting(true);
                  setSelected([h]);
                }, HISTORY_LONG_PRESS_MS);
              }}
              onPointerMove={(e) => {
                const o = pressOrigin.current;
                if (!o) return;
                if (Math.abs(e.clientX - o.x) > 10 || Math.abs(e.clientY - o.y) > 10) {
                  clearTimer();
                  pressOrigin.current = null;
                }
              }}
              onPointerUp={() => { clearTimer(); pressOrigin.current = null; }}
              onPointerLeave={() => { clearTimer(); pressOrigin.current = null; }}
              onPointerCancel={() => { clearTimer(); pressOrigin.current = null; }}
              onClick={() => {
                if (suppressClick.current) { suppressClick.current = false; return; }
                if (selecting) setSelected((s) => toggleHistorySelection(s, h));
                else onPick(h);
              }}>
              {checked && <ICheck size={12} className="mr-1 shrink-0" />}{h}
            </Button>
          );
        })}
      </div>
      {selecting && (
        <div className="mt-3 flex items-center gap-2">
          <span role="status" aria-live="polite" className="text-[12px] text-mut">已选 {validSelected.length} 条</span>
          <Button variant="danger" disabled={!validSelected.length} onClick={deleteSelected}
            className="ml-auto px-4 h-9 rounded-(--r-ctl) text-[13px] pressable">删除 · {validSelected.length}</Button>
        </div>
      )}
    </>
  );
}
