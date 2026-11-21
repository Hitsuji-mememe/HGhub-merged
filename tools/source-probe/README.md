# source-probe（探路源轻量探测）

Muse 2026-11-19 根治包·多源线条目 1。

## 做什么

对探路 4 站（JableTV / MissAV / Tik.porn / Iwara）逐个测：

1. **可达性**：列表页 plain HTTP GET 的状态码，是否被 JS 墙 / 验证墙
   （Cloudflare challenge、captcha、age-gate 等标记）挡住；
2. **可解析**：列表页 HTML 里按详情链接启发式能数出多少条目；
3. **HLS**：跟进第一个条目详情页，HTML 里能否直接提取 `.m3u8`。

两轮出口都测都记：①直连；②环境代理（`HTTPS_PROXY` 等环境变量，
本机出口为非日本——双轮出口的设计起因是已删的 Hanime1 封日本 IP，机制保留）。

## 纪律

- 只发普通 GET，不绕验证墙、不做验证码求解、不下任何媒体文件；
- 列表页样本截断 256KB 存 `fixtures/<id>-list.html`，供适配器契约
  测试当录制夹具；
- 结论只有两档：**可接入**（可达 + 无墙 + 能解析出条目）/ **降级**
  （记录原因、不写适配器）。HLS 未证实会在备注里如实标注，不假装可用。

## 用法

```sh
node tools/source-probe/probe.mjs
# 产出 results.json（原始字段）+ results.md（结论表）+ fixtures/
```
