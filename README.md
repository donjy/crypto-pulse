# Crypto Pulse · 实时行情 + 顺大逆小推荐榜 + 关键价位 + 宏观 + X 情绪

纯前端单文件页面（React 18 + Tailwind CDN），暗色风格。支持 Binance / OKX 切换；配色默认「红涨绿跌」，可一键切到「绿涨红跌」。

线上页面：https://donjy.github.io/crypto-pulse/

## 运行
```bash
cd "Crypto Pulse"
python3 -m http.server 8000
# 浏览器打开 http://localhost:8000/index.html
```
请通过 http 打开，不要直接双击用 file:// 打开，因为页面需要加载同目录下的 `signals.js`、`levels.js` 和 `snapshot.js`。所有接口都是公开接口，不需要 API Key。

小技巧：
- `?plat=okx` 直接以 OKX 数据打开（默认 Binance）。
- `#/BTCUSDT`（OKX 为 `#/BTC-USDT-SWAP`）直接打开该币种详情，链接可分享。

## 数据来源
| 模块 | 类型 | 来源 |
|---|---|---|
| BTC/ETH 现货、永续标记价、指数价、基差、资金费率 | **实时** | Binance `api/v3/ticker`、`fapi/v1/premiumIndex`、`fundingRate`；OKX `market/tickers`、`public/mark-price`、`public/funding-rate` |
| 涨幅榜 Top20、1h%、24h 走势 | **实时** | 24h ticker 加真实 1h K 线 |
| WebSocket 推送 | **实时** | Binance `!ticker@arr` / `!markPrice@arr@1s` / 现货 ticker；OKX `ws/v5/public` 的 tickers、mark-price。断线后按 1s→30s 退避重连，WS 断开期间用 REST 每 5s 轮询兜底，另外每 30s 全量刷新一次 |
| 爆仓 | **实时（统计自页面打开起）** | Binance `!forceOrder@arr` 累计；OKX `liquidation-orders`，有 REST 接口和 WS |
| 持仓量 OI | **实时** | Binance `futures/data/openInterestHist`；OKX rubik `open-interest-history` |
| K 线指标（15m/1h/4h/1d 涨幅、连阴/连阳、RSI14、量能倍数） | **实时计算** | klines / candles。只拉取 Top20 和候选币种，接口请求做了限速，结果缓存 60s |
| **关键价位（支撑/阻力、POC、价值区、盘口大单墙、入场建议）** | **实时计算** | 交易所一手数据：Binance `fapi/v1/klines` + `fapi/v1/depth`；OKX `market/candles` + `market/books`（含 `public/instruments` 的 ctVal 换算） |
| 宏观 CPI/PCE/PPI/FOMC/DXY/NFP | **人工核实快照** | 截至 2026-11-05，每项都附了来源链接。未核实的项显示 — |
| X 情绪 | **快照** | `snapshot.js`，快照时间 2026-11-05 00:45 KST。刷新方法见 `update_sentiment.md` |
| 快讯 | **快照** | X News，2026-11-05 00:50 KST |
| 巨鸟/鲸鱼动向 | **快照或示例** | 来自 X 帖子；没有可靠来源的部分标「示例」 |

## 顺大逆小信号规则（`signals.js`）
- **扫描范围**：24h 成交额前 80 的 USDT 永续（可选 40/80/120），每 3 分钟扫描一次。
- **做多条件**：
  - 1h、4h、1d 各自最近 N 根**已收盘** K 线（默认 N=2）全部收阳，且这几根的区间涨幅 > 0。
  - 同时，最近 K 根已收盘 15m K 线（默认 K=3，可在 2–5 之间调）全部收阴。
- **做空（可选）**：条件完全镜像，即大周期全部收阴、15m 连续收阳。
- **评分**：
  - score = 三个大周期区间涨幅之和 + 1.5 × min(15m 回调深度, 5%) + max(0, 45−RSI15m) × 0.3 + min(1h 量能倍数, 3)。
  - 1h 量能倍数 = 最近一根已收盘 1h K 线的成交额 ÷ 此前 24 根的平均值。
- **提醒**：点击「开启提醒」后，浏览器会请求通知权限。有新币种上榜时会弹出通知、播放提示音并高亮该行。
- 验证命令：`node test_signals.js binance`（或 `okx`）会用真实接口完整扫描一次。

## 关键价位与入场建议（`levels.js`）
详情抽屉里的「关键价位 · 支撑 / 阻力」对 5m / 15m / 1h / 4h / 1d 分别计算，数据是交易所公开 K 线与订单簿（一手数据，非第三方聚合），打开时拉取一次、之后每 60 秒刷新：

1. **成交量分布**：把每根 K 线的成交额按最高/最低价摊到 30 个价格格子，得到 POC（成交最密集价位）、70% 价值区（VAH/VAL）和成交量密集区（HVN）。同一根 K 线内用收盘价在区间中的位置拆分主动买/主动卖，用来判断某个价位是买盘还是卖盘更积极。
2. **摆动高低点**：分形法找 swing high/low，按 0.1%–0.8%（随 ATR 自适应）聚类成价位，触碰次数越多、成交量占比越大，强度分越高（同一周期内相对打分 5–97）。
3. **跨周期共振**：把 5 个周期的价位按 0.35% 带宽合并，≥2 个周期同时出现的标为共振位，周期越多强度加成越高。
4. **盘口大单墙**：订单簿近 ±3% 内的挂单按 0.12% 价格桶聚合成 USD 金额，列出买/卖各前 3 档，并给出买卖失衡比例。
5. **入场建议**：用 1d/4h/1h/15m/5m 的趋势（EMA20 vs EMA50 + 价格位置，权重 3/2/1.5/1/0.5）、资金费率（极端时反向修正）和盘口失衡算方向；再做多/做空分别取最近支撑或阻力作为入场带，止损放在结构外侧（至少 1.2×15m ATR 或 0.35% 缓冲），目标取对侧价位，输出盈亏比与失效条件。

验证命令：`node test_levels.js binance BTCUSDT` 或 `node test_levels.js okx BTC-USDT-SWAP`（会打印各周期支撑阻力、共振位、盘口墙和入场建议，并对结果做一致性断言）。

⚠ 所有价位与建议都是按固定规则的机械计算，不含手续费、滑点与资金费率成本，**仅供参考，不构成投资建议**。

## 颜色与语言
- 默认**红涨绿跌**（A 股/国内习惯），可切换为**绿涨红跌**，选择保存在 localStorage。
- 界面文案与 X 帖子统一为简体中文；`snapshot.js` 里 `posts[].text` 是译文，`textEn` 保留英文原文（悬停帖子可见原文），链接仍指向 X 原帖。

## 文件
- `index.html`：主页面
- `signals.js`：信号和指标逻辑，浏览器和 Node 共用
- `levels.js`：关键价位、成交量分布、盘口大单与入场计划，浏览器和 Node 共用
- `snapshot.js`：X 情绪和快讯快照（`text` 中文译文 + `textEn` 原文）
- `update_sentiment.md`：快照刷新流程
- `test_signals.js`：信号逻辑测试
- `test_levels.js`：关键价位计算测试（真实接口）

⚠ 仅供参考，不构成投资建议。
