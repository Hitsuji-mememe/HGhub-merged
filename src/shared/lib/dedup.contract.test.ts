/**
 * appendDeduped 契约测试（Muse 2026-11-19 根治包 P2-20）：
 * 运行：node src/shared/lib/dedup.contract.test.ts（Node ≥22 类型剥离直跑）
 * 覆盖四处入口共用的同一实现：Discover 专题/标签视频/标签帖、Category 频道页。
 */
import assert from "node:assert/strict";
import { appendDeduped, dedupedIncoming } from "./dedup.ts";

type Item = { id: number };
const byId = (x: Item) => x.id;

// 页内含重复 ID：同一页 incoming 自带重复时只入一条（旧 filter 实现会漏过）
{
  const out = appendDeduped<Item>([], [{ id: 1 }, { id: 2 }, { id: 2 }, { id: 1 }, { id: 3 }], byId);
  assert.deepEqual(out.map((x) => x.id), [1, 2, 3], "页内重复只入一条");
}
// 与 prev 重叠：已加载过的不再入
{
  const out = appendDeduped<Item>([{ id: 1 }, { id: 2 }], [{ id: 2 }, { id: 3 }, { id: 3 }], byId);
  assert.deepEqual(out.map((x) => x.id), [1, 2, 3], "跨页重复剔除且页内去重");
}
// 空 incoming / 空 prev 边界
assert.deepEqual(appendDeduped<Item>([{ id: 1 }], [], byId).map((x) => x.id), [1]);
assert.deepEqual(appendDeduped<Item>([], [], byId), []);
// dedupedIncoming（Category 分页数组形态共用同一核心）：只返回新增部分
{
  const added = dedupedIncoming<Item>([{ id: 5 }], [{ id: 5 }, { id: 6 }, { id: 6 }, { id: 7 }], byId);
  assert.deepEqual(added.map((x) => x.id), [6, 7], "dedupedIncoming 只返回新条目且页内去重");
}
// 字符串 id 同样适用
{
  const out = appendDeduped([{ id: "a" }], [{ id: "a" }, { id: "b" }, { id: "b" }], (x) => x.id);
  assert.deepEqual(out.map((x) => x.id), ["a", "b"]);
}
console.log("dedup.contract: all assertions passed");
