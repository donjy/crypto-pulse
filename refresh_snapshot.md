# 舆情快照刷新流程（每 30 分钟）

## 1. 选币
- 固定：BTC、ETH
- 动态（合计最多约 10 个）：当前推荐榜命中的币，加 Binance 涨幅榜前 5。用 `node test_signals.js binance` 查推荐榜（约 4.5 分钟）；涨幅榜直接看 `https://fapi.binance.com/fapi/v1/ticker/24hr`，按 priceChangePercent 降序。

## 2. X 搜索（用 Grok Bot 的 `x` 工具，单次 ≤15 次调用）
- 每个币调一次 `search_posts_all`，取近 24h，例如：`($BTC OR #bitcoin OR bitcoin) lang:en -is:retweet`、`($ETH OR ethereum) ...`、`$XMR ...`。
- 调一次 `search_news`，查询 `crypto`，作为快讯来源。
- 原始结果覆盖写入 `.x_raw.json`。

## 3. 写 snapshot.js（结构不要改）
```js
window.SNAPSHOT = {
  snapshotTime: 'YYYY-MM-DD HH:mm KST',
  sentiment: { BTC: { sample, bull, bear, neutral, score, headline, summary, themes:[...],
                      posts:[{url,text,textEn,likes,note,time}], whale:null }, ... },
  news: { snapshotTime: '... KST', items:[{title,summary,url,updated}] },
  recommendationAtSnapshot: [...]
};
```
- bull/bear/neutral 填百分比，score = (bull − bear) / 100。剔除 spam 和机器人帖。
- headline 和 summary 用中文写，每个币挑 2–3 条代表帖，附真实链接。
- **帖子必须译成简体中文**写入 `text`，英文原文写入 `textEn`（页面悬停显示原文）。帖子原本是中文时可省略 `textEn`。

## 4. 发布
- 页面每 5 分钟会带时间戳重新拉取 `./snapshot.js` 并原地更新。只要托管处的 snapshot.js 被替换，用户不用刷新页面就能看到新快照。
- 托管位置还没定。目前 box 上无法建立免账号的稳定公网地址，见下方说明。定了托管方式之后，在这里补上部署命令，例如 GitHub Pages：`git commit snapshot.js && git push`。

## 已尝试、在 box 上不可用的方式（2026-11-05）
- Cloudflare quick tunnel：QUIC 和 http2 都连不上边缘节点（7844 端口被阻断）。
- localhost.run / pinggy / serveo（SSH）：连接被关闭。
- localtunnel：能拿到 URL，但数据通道返回 502/503。
- tunnelmole：8083 端口 ECONNRESET。
- 0x0.st：已停止上传。x0.at：以 text/plain 返回，JS 不会执行。catbox：无响应。litterbox：返回 500，且本身 72h 过期、每次上传换新 URL。
