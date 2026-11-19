#!/usr/bin/env python3
"""HGhub 目录导入生成器（Muse 2026-11-19 根治包·多源线）。

从 Hentai-Park（github.com/drdon1234/Hentai-Park，AGPL-3.0）的
assets/sources/index.json + 各 .js 注册头机械提取元数据（key/名称/
类型/类别/主页），生成 src/features/sources/catalog.ts。

口径（用户 2026-11-19 定版）：
- 排除：直播/录播、小说、音声、游戏、AI 酒馆、漫画（doujin）、
  工具类（图片反搜等）、社交平台（需账号会话、非内容源）；
- 与命名源重复的（id/名称/主页域名命中）沿用命名源实测结论，不重复导入；
- 同站子集（shorties、rouvideo-drama）保留条目、note 标明子集关系；
- 其余一律 maturity=probe、enabled=false（注册保留、清单可远程启用）、
  note「目录导入·未实测」，按类别匹配通用模板骨架，不假称验通。
只搬元数据事实（名称/入口/类别），不搬对方代码（AGPL 干净室口径）。
"""
import json, re, os, sys
from urllib.parse import urlparse

SRC = sys.argv[1]  # hentai-park checkout
OUT = sys.argv[2]  # catalog.ts output path

idx = json.load(open(os.path.join(SRC, 'assets/sources/index.json')))

def homepage(key, file):
    p = os.path.join(SRC, 'assets/sources', file)
    txt = open(p, encoding='utf8', errors='replace').read() if os.path.exists(p) else ''
    m = re.search(r"homepage:\s*'([^']+)'", txt) or re.search(r"origin:\s*'([^']+)'", txt)
    return m.group(1) if m else ''

# 命名源对应表：catalog key -> 本仓命名源 id（去重命中即跳过导入）
NAMED = {
    'huangguo': 'huangguo', 'feed51cg': '51chigua', 'feedmrds': 'meiridasai',
    'porn91': '91video', 'hanime': 'hanime-tv', 'hanime1': 'hanime1',
    'jable': 'jabletv', 'missav': 'missav', 'pornhub': 'pornhub',
    'xvideos': 'xvideos', 'rouvideo': 'rouvideo', 'rule34video': 'rule34video',
    'iwara': 'iwara', 'tikporn': 'tikporn', 'fyptt': 'fyptt',
    'redgifs': 'redgifs', 'swag_shortvideo': 'swag', 'xiuren': 'xiuren',
    'pornpics': 'pornpics', 'cosplaytele': 'cosplaytele', 'danbooru': 'danbooru',
    'myfans': 'myfans', 'catalog-fc2': 'fc2',
}
# 人工指定主页（注册头未给 homepage/origin 的纳入条目）
MANUAL_HOME = {
    'feedheiliao': 'https://heiliao.com',
    'pixibb': 'https://sexy.pixibb.com',
    'nudecosplay': 'https://nudecosplay.biz',
    'pixiv': 'https://www.pixiv.net',
    'fanbox': 'https://www.fanbox.cc',
}
EXCLUDE_TYPE = {'tavern', 'voice', 'novel', 'game'}
EXCLUDE_CAT = {'live', 'recording', 'novel', 'asmr', 'tavern', 'game', 'onlineGame', 'doujin'}
EXCLUDE_KEY = {  # 工具类（图片反搜/识别）与社交平台（非内容源）
    'google_lens', 'yandex', 'baidu', 'trace_moe', 'anime_trace', 'iqdb',
    'ehentai_reverse', 'avscan', 'reddit', 'x', 'telegram',
}
SUBSET_NOTE = {
    'shorties': 'Pornhub 站内竖屏短视频分区，与命名源 Pornhub 同站、属其子集',
    'rouvideo-drama': '肉视频站内短剧分区（rou.video/series），与命名源肉视频同站、属其子集',
}

def map_category(s):
    t, c = s['type'], s['category']
    if t == 'article' and c == 'feed':
        return 'posts'
    if t == 'video':
        return 'video'
    if t == 'comic' and c in ('gallery', 'illustration'):
        return 'image'
    if s['key'] == 'pixiv':
        return 'image'  # 插画社区：漫画部分不在导入目标内，按图集源登记
    if s['key'] == 'fanbox':
        return 'preview'
    return None

def template_for(key, cat):
    if cat == 'posts':
        return 'chigua', {'listPath': '/?page={page}', 'itemLinkPattern': '/archives/', 'detailPath': '/archives/{id}'}
    if cat == 'video':
        return 'hls-site', {'listPath': '/?page={page}', 'itemLinkPattern': '/video/', 'detailPath': '/video/{id}'}
    if cat == 'image':
        if key in ('yandere', 'gelbooru'):
            return 'danbooru-api', {'listPath': '/posts.json'}
        return 'wp-rest', {'restBase': '/wp-json/wp/v2', 'listPath': '/posts'}
    return 'preview-only', None

stats = {'total': 0, 'excluded': 0, 'deduped': 0, 'imported': 0}
excluded_keys, deduped_keys = [], []
entries = []
order = 100
for s in idx['sources']:
    stats['total'] += 1
    key = s['key']
    if s['type'] in EXCLUDE_TYPE or s['category'] in EXCLUDE_CAT or key in EXCLUDE_KEY:
        stats['excluded'] += 1
        excluded_keys.append(key)
        continue
    if key in NAMED:
        stats['deduped'] += 1
        deduped_keys.append(key)
        continue
    cat = map_category(s)
    if cat is None:
        stats['excluded'] += 1
        excluded_keys.append(key)
        continue
    home = MANUAL_HOME.get(key) or homepage(key, s['file'])
    assert home.startswith('http'), f'{key}: no homepage'
    tpl, params = template_for(key, cat)
    note = '目录导入·未实测（Hentai-Park 目录，2026-11-19）：' + (s.get('description') or '')
    if key in SUBSET_NOTE:
        note += '；' + SUBSET_NOTE[key]
    note += '；模板参数为通用骨架、未按真站校准'
    entries.append({
        'id': key.replace('_', '-'), 'displayName': s['name'],
        'kind': {'posts': 'post', 'video': 'video', 'image': 'image', 'preview': 'mixed'}[cat],
        'category': cat, 'template': tpl, 'params': params,
        'baseUrls': [home], 'order': order, 'note': note,
    })
    order += 1
    stats['imported'] += 1

def js_str(v):
    return json.dumps(v, ensure_ascii=False)

lines = []
lines.append('/**')
lines.append(' * 目录导入源（Muse 2026-11-19 根治包·多源线，机械生成、勿手改）。')
lines.append(' * 生成器：tools/source-import/generate_catalog.py（Hentai-Park 目录')
lines.append(' * 元数据机械提取：名称/入口/类别；只搬事实不搬代码，AGPL 干净室）。')
lines.append(' * 口径：全部 maturity=probe、enabled=false（注册保留，远程清单可')
lines.append(' * 按 id 启用/改域名，不必重出包）；note 均为「目录导入·未实测」，')
lines.append(' * 模板参数为通用骨架、未按真站校准——不许据此声称验通。')
lines.append(' */')
lines.append('import type { SourceDef } from "./types.ts";')
lines.append('')
lines.append('const NO_CAPS = { search: false, episodes: false, hevc: false, comments: false };')
lines.append('const PROBE_NET = { mode: "probe-required" } as const;')
lines.append('')
lines.append('export const CATALOG_SOURCES: SourceDef[] = [')
for e in entries:
    params = f', params: {js_str(e["params"])}' if e['params'] else ''
    lines.append('  {')
    lines.append(f'    id: {js_str(e["id"])}, displayName: {js_str(e["displayName"])}, kind: {js_str(e["kind"])}, category: {js_str(e["category"])},')
    lines.append(f'    adapter: {{ template: {js_str(e["template"])}{params} }},')
    lines.append(f'    baseUrls: {js_str(e["baseUrls"])},')
    lines.append(f'    enabled: false, order: {e["order"]}, maturity: "probe",')
    lines.append(f'    capabilities: NO_CAPS, network: PROBE_NET, note: {js_str(e["note"])},')
    lines.append('  },')
lines.append('];')
lines.append('')
open(OUT, 'w', encoding='utf8').write('\n'.join(lines))
print(json.dumps(stats, ensure_ascii=False))
print('excluded:', ','.join(excluded_keys))
print('deduped:', ','.join(deduped_keys))
print('imported ids:', ','.join(e['id'] for e in entries))
