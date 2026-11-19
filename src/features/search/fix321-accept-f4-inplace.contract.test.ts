/**
 * 3.2.1 验收 C 线证伪探针（F4 展示面遍历专项，维护者任务书授权新增）：
 * 频道内站内搜索 InplaceSearch 与不变量的冲突定性。
 *
 * 不变量：「任一条目按内容性质只进一个分区/页签……有分集/剧集
 * 结构的只归短剧，绝不进视频。」
 *
 * 运行：node src/features/search/fix321-accept-f4-inplace.contract.test.ts
 *
 * 口径：InplaceSearch 经 useSearchResults 圈定范围——scope="original"
 * 时仅以 is_original===1 过滤（useSearchResults.ts 字面表达式，本
 * 探针复刻并以源码文本绑死）；scope 缺席时无任何过滤、走全局
 * api.search(type=video)。两面都未接 contentKind 判定（新旧码该
 * 两文件逐字相同，diff 已验）。呈现标签：scope="original" 面标
 * 「视频」（ChannelPage original 搜索钮 aria-label「搜索视频」、
 * InplaceSearch videoLabel 同口径）；scope 缺席面标「短剧」
 * （videoLabel 兜底＋多处调用方搜索钮 aria-label「搜索短剧」）。
 *
 * 预期：本探针在新码（fix321/vc）上即为红——多集原创短剧经
 * is_original 过滤进入「视频」标签面、真单条经无过滤进入「短剧」
 * 标签面，两条均为不变量的真实违例，定性记录于验收档案，不在本
 * 线修生产代码。
 * 不访问真实网络。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

let failures = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); console.log(`PASS ${name}`); }
  catch (e) { failures++; console.log(`FAIL ${name}: ${(e as Error).message}`); }
};

const useSearchSrc = read("./useSearchResults.ts");
const inplaceSrc = read("./InplaceSearch.tsx");
const categorySrc = read("../category/Category.tsx");

type Card = { id: number; title: string; episode_count: number; total_episodes: number; is_original: number };
/* 《警界之花》频道形态：3 集、is_original=1（original 端点即
 * /api/videos?is_original=1 下发，短剧与单条同为原创，见 f4b 根因
 * 「is_original 不区分性质」）。 */
const jingjie: Card = { id: 9101, title: "警界之花", episode_count: 3, total_episodes: 3, is_original: 1 };
const singleOriginal: Card = { id: 9104, title: "单条视频甲", episode_count: 1, total_episodes: 1, is_original: 1 };
const singleNonOriginal: Card = { id: 9106, title: "单条视频丙", episode_count: 1, total_episodes: 1, is_original: 0 };

/* useSearchResults 圈定表达式复刻（与生产字面一致，见绑定断言）：
 * incoming.filter(item => !(scope === "original" && kind === "video") || item.is_original === 1) */
const inplaceFilter = (items: Card[], scope?: "original") =>
  items.filter((item) => !(scope === "original") || item.is_original === 1);

check("生产绑定：InplaceSearch 圈定口径与源码字面对齐", () => {
  assert.ok(useSearchSrc.includes('item.is_original === 1'), "useSearchResults 仅以 is_original 圈定 original 面");
  assert.ok(!useSearchSrc.includes("contentKind") && !useSearchSrc.includes("partitionCardsByKind")
    && !useSearchSrc.includes("searchKindForHuangguoVideo") && !useSearchSrc.includes("kindForHuangguoVideo"),
    "useSearchResults 未接任何内容性质判定");
  assert.ok(!inplaceSrc.includes("contentKind") && !inplaceSrc.includes("partitionCardsByKind"),
    "InplaceSearch 未接任何内容性质判定");
  assert.ok(inplaceSrc.includes('scope === "original" ? "视频" : "短剧"'), "标签口径：original 面标视频、其余面标短剧");
  assert.ok(categorySrc.includes('scope={cate === "original" ? "original" : undefined}'), "ChannelPage 仅 original 频道传 scope");
});

check("违例面1：多集短剧不进「视频」标签的站内搜索（original 面）", () => {
  const shown = inplaceFilter([jingjie, singleOriginal, singleNonOriginal], "original");
  assert.ok(!shown.some((c) => c.id === 9101),
    `《警界之花》（3 集、is_original=1）被 is_original 口径放行进「视频」面：实际放行=[${shown.map((c) => c.title).join(",")}]`);
});

check("违例面2：真单条不进「短剧」标签的站内搜索（ai-duanju 等无 scope 面）", () => {
  const shown = inplaceFilter([jingjie, singleOriginal, singleNonOriginal], undefined);
  assert.ok(!shown.some((c) => c.id === 9104 || c.id === 9106),
    `无 scope 面零过滤、全局搜索结果直出「短剧」面：单条=[${shown.filter((c) => c.episode_count <= 1).map((c) => c.title).join(",")}]`);
});

if (failures > 0) {
  console.log(`fix321-accept-f4-inplace.contract: ${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("fix321-accept-f4-inplace.contract: all assertions passed");
