import React, { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { AppProvider, useStore } from "../src/shared/model/store";
import { mergeMigratedAccountData, type AccountData } from "../src/shared/model/accountData";

function Probe() {
  const store = useStore();
  useEffect(() => {
    Object.assign(window, { storageMigrationFixture: { ...store, getThemePreference: () => store.themePreference } });
  }, [store]);
  return <pre>{JSON.stringify({
    likes: store.likes, favs: store.favs, history: store.history, follows: store.follows,
    searchHist: store.searchHist, volume: store.volume, muted: store.muted,
    muteOnStartup: store.muteOnStartup, swipeEp: store.swipeEp,
    preferHevc: store.preferHevc, fsIdleSecs: store.fsIdleSecs, theme: store.theme,
  })}</pre>;
}

/* P1-2 迁移合并纯函数用例（Muse 2026-11-19 根治包）：目标桶已存在 +
 * 旧桶有未上传进度 → 合并后进度在、新者胜、集合并集。 */
{
  const base = (over: Partial<AccountData>): AccountData => ({
    likes: [], favs: [], follows: [], history: [], postLikes: [], postFavs: [],
    dirtyHistory: {}, localHistory: [], ...over,
  });
  const target = base({
    favs: [7],
    history: [{ id: 44, ep: 2, t: 5, dur: 80, at: 1000 }, { id: 45, ep: 1, t: 0, dur: 60, at: 900 }],
    dirtyHistory: { 45: { ep: 1, at: 900 } },
    localHistory: [45],
  });
  const previous = base({
    favs: [8],
    history: [{ id: 44, ep: 3, t: 12.5, dur: 80, at: 2000 }, { id: 46, ep: 1, t: 3, dur: 30, at: 800 }],
    dirtyHistory: { 44: { ep: 3, at: 2000 } },
    localHistory: [44, 46],
  });
  const merged = mergeMigratedAccountData(target, previous);
  Object.assign(window, { __accountMerge: {
    history44: merged.history.find(r => r.id === 44),
    historyIds: merged.history.map(r => r.id),
    dirty44: merged.dirtyHistory[44] ?? null,
    dirty45: merged.dirtyHistory[45] ?? null,
    localHistory: merged.localHistory,
    favs: merged.favs,
  } });
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode><AppProvider><Probe /></AppProvider></React.StrictMode>,
);
