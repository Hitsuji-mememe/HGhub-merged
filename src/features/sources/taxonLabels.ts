/**
 * 发现行汉化映射（Muse 2026-11-21 fix3312/discovery-b，调查
 * fix3312/evidence/discovery-design-research.md 选项 B 第 3 段）。
 *
 * 只改显示层：本模块只产出 chip 的显示文案与标签搜索的中文反查
 * 索引，DiscoveryOption 的 value（筛选参数真值）永不经此改写——
 * 点选回传的仍是站方原值，筛选行为与未汉化时逐字一致。
 *
 * 收录口径（铁律）：
 * - 题材词（跨源复现的同一批词彙）进共享表；逐源分类（属性桶/
 *   地域桶/厂牌中文名）进源表，源表优先于共享表。
 * - 专名（人名/作品名/机构名/出版物名）一律不译、回落原名——
 *   它们是名字与检索键，机翻只会帮倒忙（调查 §一.4）。
 * - 词义有歧义、译法不统一的宁可不收（如 006 分类 Hot Girl 无
 *   公认中文名、bdsm/filmed 译法不一），回落原名不报错。
 * - 数据来源：2026-11-21 经生产同路实拉各源 taxonomy 端点
 *   （WP categories/tags 按 count 降序 Top-100＋002 目录全量
 *   聚合），与调查报告逐源规模表逐项吻合；键以显示名登记、
 *   加载时经 normalizeDiscoveryName 规范化（去首尾空白＋小写）。
 */
import { normalizeDiscoveryName } from "./discoveryOptions.ts";
import type { DiscoveryOption } from "./adapters/templateCapabilities.ts";

/* 共享题材词表：002 题材词全集（61 中可译 57）、020 全集（35 中
 * 可译 32）、021 高频段与各 WP 源 Top 标签中的题材词子集，含跨
 * 源拼写变体（分写/连写/单复数）。专名与年份、厂牌、平台名不收。 */
export const SHARED_TAXON_LABELS_ZH: Record<string, string> = {
  /* 行为类 */
  "Blow Job": "口交", "Blowjob": "口交", "Hand Job": "手交", "Handjob": "手交",
  "Foot Job": "足交", "Footjob": "足交", "Boob Job": "乳交", "Boobjob": "乳交",
  "Tits Fuck": "乳交", "Anal": "肛交", "Creampie": "中出", "Internal Cumshot": "中出",
  "Facial": "颜射", "Bukkake": "颜射", "Gangbang": "轮交", "Orgy": "乱交",
  "Threesome": "三人行", "Three Some": "三人行", "Masturbation": "自慰",
  "Bondage": "捆绑", "Tentacle": "触手", "Tentacles": "触手", "X-Ray": "透视",
  "Sex Toy": "性玩具", "Toys": "玩具", "Double Penetration": "双插",
  "Double Penatration": "双插", "Inflation": "膨胀", "Rimjob": "舔肛",
  "Rim Job": "舔肛", "DeepThroat": "深喉", "Deep Throat": "深喉",
  "Facesitting": "坐脸", "Squirting": "潮吹", "Urination": "排尿",
  "POV": "第一人称",
  "Watersports": "放尿", "Scat": "粪便", "Beastiality": "兽交",
  "Bestiality": "兽交", "Rape": "强奸", "Mind Break": "精神崩坏",
  "Mind Control": "精神控制", "Brainwashed": "洗脑", "Hypnosis": "催眠",
  "Blackmail": "胁迫", "Humiliation": "羞辱", "Torture": "拷问",
  "Molestation": "痴汉", "Train Molestation": "电车痴汉", "Cheating": "出轨",
  "Incest": "乱伦", "Exhibition": "露出", "Public Sex": "公共场所",
  /* 关系/属性类 */
  "Harem": "后宫", "Vanilla": "纯爱", "Femdom": "女性主导", "Slaves": "奴隶",
  "Slave": "奴隶", "Housewife": "人妻", "MILF": "熟女", "Virgin": "处女",
  "Virgins": "处女", "Widow": "寡妇", "Gyaru": "辣妹", "Tsundere": "傲娇",
  "Ahegao": "阿黑颜", "Megane": "眼镜", "Glasses": "眼镜", "Nekomimi": "猫耳",
  "Cat Girl": "猫娘", "Futanari": "扶她", "Trap": "伪娘", "Yuri": "百合",
  "Yaoi": "耽美", "Lolicon": "萝莉", "Shoutacon": "正太", "NTR": "牛头人",
  "Reverse NTR": "逆NTR", "Big Boobs": "巨乳", "Large Breasts": "巨乳",
  "Dark Skin": "黑肤", "Lactation": "授乳", "Pregnant": "孕妇",
  "Ugly Bastard": "丑男",
  /* 角色/服饰类 */
  "School Girl": "女学生", "School Girls": "女学生", "Schoolgirl": "女学生",
  "School": "校园", "JK": "女高中生", "Maid": "女仆", "Nurse": "护士",
  "Nurses": "护士", "Teacher": "教师", "Female Teacher": "女教师",
  "Female Doctor": "女医生", "Office Ladies": "职场女性", "Nun": "修女",
  "Nuns": "修女", "Miko": "巫女", "Elf": "精灵", "Demon": "恶魔",
  "Demons": "恶魔", "Devil": "恶魔", "Monster": "怪物", "Monsters": "怪物",
  "Goblins": "哥布林", "Vampire": "吸血鬼", "Succubus": "魅魔",
  "Magical Girls": "魔法少女", "Princess": "公主", "Idols": "偶像",
  "Swimsuit": "泳装", "Bikini": "比基尼", "Lingerie": "内衣",
  "Stocking": "丝袜", "Stockings": "丝袜", "Shimapan": "条纹内裤",
  "Uniform": "制服", "Kimono": "和服", "Cheongsam": "旗袍",
  "Bunny Girl": "兔女郎", "Bunny": "兔女郎", "Cosplay": "角色扮演",
  "Sexy Cosplay": "性感角色扮演", "Coser": "角色扮演者",
  /* 类型/风格类 */
  "Fantasy": "奇幻", "Horror": "恐怖", "Comedy": "喜剧", "Romance": "恋爱",
  "Adventure": "冒险", "Action": "动作", "Sci-Fi": "科幻",
  "Historical": "历史", "Sports": "运动", "Martial Arts": "武术",
  "Super Power": "超能力", "Supernatural": "超自然", "Violence": "暴力",
  "Gore": "血腥", "Cyberpunk": "赛博朋克", "Anime": "动漫",
  "Anime Girl": "动漫少女", "Ecchi": "工口", "Softcore": "软核",
  "Motion Anime": "动态动画",
  /* 形式/状态/通用桶 */
  "Uncensored": "无码", "Censored": "有码", "HD": "高清", "Preview": "预告",
  "Hentai Previews": "预告", "Series": "系列", "Short Series": "短篇系列",
  "Exclusive": "独家", "Remastered": "重制版", "Uncategorized": "未分类",
  "Featured": "精选", "AI Generated": "AI生成", "AIGirl": "AI美女",
  "AI Enhanced": "AI增强", "Collection": "合集", "Photobook": "写真集",
  "Digital Photobook": "数字写真集", "Digital Exclusive": "数字独家",
  "Selfie": "自拍", "Model": "模特", "Chinese Model": "华人模特",
  "Sexy": "性感", "Sexy Girl": "性感美女", "Sexy Girls": "性感美女",
  "Nude": "裸体", "Naked": "裸体", "Christmas": "圣诞",
  "European Girls": "欧美美女", "Chinese Hentai": "国产里番",
  "Gay Hentai": "男同", "Body Switch": "灵魂互换",
  "Body Switching": "灵魂互换", "Body Swithing": "灵魂互换",
  "Plot": "有剧情", "Mild Nudity": "轻度裸露",
};

/* 逐源分类表：018 地域桶 4（Cosplay/Uncategorized 走共享表）、
 * 021 属性桶 6（Uncensored/Preview 走共享表）、012 题材桶 4
 * （Anime/Cosplay/Uncategorized 走共享表、Almost Real/Hot Games
 * 语义不明不收）、013 题材桶 3（Nude/Uncategorized 走共享表、
 * Waifu AI 译法不一不收）、006 厂牌中文名 14（Hot Girl 无公认
 * 中文名不收、DJAWA 为机构专名不译、AI Generated/Cosplay/
 * Featured 走共享表）。006 的厂牌名同时是其标签大头，源表对
 * 分类/标签两行同等生效（同名同物）。 */
export const SOURCE_TAXON_LABELS_ZH: Record<string, Record<string, string>> = {
  everia: {
    "Japan": "日本", "China": "中国", "Korea": "韩国", "Thailand": "泰国",
  },
  hentaiplay: {
    "Hentai Anime": "动画里番", "English Subbed": "英文字幕",
    "Hentai": "里番", "New Hentai": "最新里番", "RAW": "生肉",
    "3D Hentai": "3D里番",
  },
  pixibb: {
    "Eu Girls": "欧美美女", "AI Lookbook": "AI图集", "Toon Girls": "卡通女郎",
  },
  nudecosplay: {
    "Ero Cosplay": "情色角色扮演", "Online Video": "在线视频",
    "Sexy Set": "性感套图",
  },
  xiuren: {
    "XiuRen": "秀人网", "XiuRen Extra": "秀人Extra", "Ugirls": "尤果网",
    "YouMi": "尤蜜荟", "XiaoYu": "画语界", "XINGYAN": "星颜社",
    "HuaYang": "花漾", "IMISS": "爱蜜社", "FeiLin": "飞林社",
    "MFStar": "模范学院", "MyGirl": "美媛馆", "MiiTao": "蜜桃社",
    "MiStar": "魅妍社", "YouWu": "尤物馆",
  },
};

const buildIndex = (table: Record<string, string>): Map<string, string> => {
  const m = new Map<string, string>();
  for (const [k, v] of Object.entries(table)) m.set(normalizeDiscoveryName(k), v);
  return m;
};
const sharedIndex = buildIndex(SHARED_TAXON_LABELS_ZH);
const sourceIndexes = new Map(
  Object.entries(SOURCE_TAXON_LABELS_ZH).map(([id, t]) => [id, buildIndex(t)] as const),
);

/** 显示名解析：源表优先、共享表兜底；无映射返回 null（回落原名）。 */
export function taxonZhLabel(sourceId: string, name: string): string | null {
  const key = normalizeDiscoveryName(name);
  return sourceIndexes.get(sourceId)?.get(key) ?? sharedIndex.get(key) ?? null;
}

/** chip 显示文案：有译名用译名、无译名原样。value 永不经此函数。 */
export function taxonDisplayLabel(sourceId: string, option: DiscoveryOption): string {
  return taxonZhLabel(sourceId, option.label) ?? option.label;
}

/** 中文反查索引：译名包含 query 的全部规范化原名键（共享表＋全
 * 部源表——命中与否最终由当前源的选项集过滤，跨源键无副作用）。 */
export function taxonKeysForChineseQuery(query: string): Set<string> {
  const q = query.trim();
  const out = new Set<string>();
  if (!q) return out;
  for (const [k, v] of sharedIndex) if (v.includes(q)) out.add(k);
  for (const idx of sourceIndexes.values()) {
    for (const [k, v] of idx) if (v.includes(q)) out.add(k);
  }
  return out;
}

/** 标签行内搜索的单条匹配：原名子串（不分大小写；value 为非数字
 * 形态时同查——002 的 value 即原名）或中文译名经反查键命中。 */
export function tagOptionMatchesQuery(
  option: DiscoveryOption,
  query: string,
  zhKeys: Set<string>,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (option.label.toLowerCase().includes(q)) return true;
  if (!/^\d+$/.test(option.value) && option.value.toLowerCase().includes(q)) return true;
  return zhKeys.has(normalizeDiscoveryName(option.label))
    || zhKeys.has(normalizeDiscoveryName(option.value));
}
