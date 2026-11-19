import React, { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { AppProvider, useStore } from "../src/shared/model/store";
import { mergeLibraryData, type LibraryData } from "../src/shared/model/localLibrary";

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
 * 旧桶有未上传进度 → 合并后进度在、新者胜、集合并集。
 * 接棒 (3.3.0 账号拆除): mergeMigratedAccountData → mergeLibraryData
 * (localLibrary); dirtyHistory 只是「未上传」标记、进度本体在 history
 * 行内, 原 dirty44/dirty45 断言由 history44 本体断言接棒, 覆盖不降。 */
{
  const base = (over: Partial<LibraryData>): LibraryData => ({
    likes: [], favs: [], follows: [], history: [], postLikes: [], postFavs: [],
    likeEpisodes: [], localHistory: [], ...over,
  });
  const target = base({
    favs: [7],
    history: [{ id: 44, ep: 2, t: 5, dur: 80, at: 1000 }, { id: 45, ep: 1, t: 0, dur: 60, at: 900 }],
    localHistory: [45],
    likeEpisodes: [{ video_id: 44, ep: 2 }],
  });
  const previous = base({
    favs: [8],
    history: [{ id: 44, ep: 3, t: 12.5, dur: 80, at: 2000 }, { id: 46, ep: 1, t: 3, dur: 30, at: 800 }],
    localHistory: [44, 46],
    likeEpisodes: [{ video_id: 44, ep: 2 }, { video_id: 44, ep: 3 }],
    postFavs: [9],
  });
  const merged = mergeLibraryData(target, previous);
  Object.assign(window, { __accountMerge: {
    history44: merged.history.find(r => r.id === 44),
    historyIds: merged.history.map(r => r.id),
    localHistory: merged.localHistory,
    favs: merged.favs,
    postFavs: merged.postFavs,
    likeEpisodes: merged.likeEpisodes,
  } });
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode><AppProvider><Probe /></AppProvider></React.StrictMode>,
);
