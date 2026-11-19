import { useEffect } from "react";
import { setDetailNextHandler } from "../../shared/lib/detailNext";
import type { Episode } from "../../shared/api/types";

/** 详情页左划「下一集/下一条」注册（fix2.1 批四#12 的 Feed 侧）。
 * 语义与桌面控制层 onNext 一致：有下一集先切集、否则切下一条作品；
 * 已在最后一集且无下一条时返回未消费（左划无动作）。enabled 为
 * context 模式且 active（栈顶可见）时才持有注册，卸载/失活即注销。
 * 独立成 hook 文件：Feed.tsx 已在尺寸预算边缘，注册逻辑不占其行数。 */
export function useDetailNext(opts: {
  enabled: boolean;
  episodes: Episode[];
  curEp: number;
  index: number;
  count: number;
  pickEp: (ep: number) => void;
  go: (delta: number) => void;
}): void {
  const { enabled, episodes, curEp, index, count, pickEp, go } = opts;
  useEffect(() => {
    if (!enabled) return;
    setDetailNextHandler(() => {
      const nx = episodes.find((e) => e.ep_num === curEp + 1);
      if (nx) { pickEp(nx.ep_num); return true; }
      if (index < count - 1) { go(1); return true; }
      return false;
    });
    return () => setDetailNextHandler(null);
  }, [enabled, episodes, curEp, index, count, pickEp, go]);
}
