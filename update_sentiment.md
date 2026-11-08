# X 情绪 / 快讯快照 · 定时刷新说明

浏览器端无法直接调用 X API（需要鉴权），所以情绪和快讯是**快照**，存放在 `snapshot.js`（`window.SNAPSHOT`）里。页面上会标「快照」以及快照时间（KST）。

## 刷新流程（建议每 2–4 小时一次）
1. 取币种：BTC、ETH，加上当前涨幅榜 Top20 和推荐榜命中的币种，最多约 10 个。
2. 用 Grok Bot 的 `x` 工具（`search_posts_all`）逐个搜索，例如 `($BTC OR #bitcoin) lang:en -is:retweet`，取近 24h 的帖子，每个币一次调用。再调用一次 `search_news`，查询 crypto 快讯。总共约 11–15 次调用。
3. 原始结果写入 `.x_raw.json`，用于留档和复核。
4. 逐个币种统计：样本数、多/空/中性占比、score = (多−空)/样本，写一行中文 headline 和 summary，列 themes，再挑 2–3 条代表帖（url / 中文译文 / 英文原文 / 点赞 / 时间）。
   - **所有帖文都要翻成简体中文**放在 `posts[].text`，英文原文放进 `posts[].textEn`（页面悬停可看原文）。专有名词（项目名、代币代码、机构名）保持原样，数字与百分比照抄。
   - 若帖子本身是中文，`text` 直接用原文，可省略 `textEn`。
5. 更新 `snapshot.js` 里的 `snapshotTime`（格式 `YYYY-MM-DD HH:mm KST`）、`sentiment`、`news`、`recommendationAtSnapshot`。
6. 页面会自动读取 `snapshot.js`，刷新浏览器即可生效。

## 自动化
可以让 Grok Bot 建一个 routine（例如每 3 小时一次），按上面的步骤执行，再覆盖 `snapshot.js`。
注意事项：
- X 搜索有频率限制，单次刷新控制在约 15 次调用以内。
- 机器人和营销帖较多，统计时要剔除明显的 spam。
- 情绪只是舆论倾向，不是价格信号。
