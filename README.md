# Crypto Pulse · 实时行情 + 顺大逆小推荐榜 + 宏观 + X 情绪

纯前端单文件页面（React 18 + Tailwind CDN），暗色风格。支持 Binance / OKX 切换，也可以切换「绿涨红跌 / 红涨绿跌」。

线上页面：https://donjy.github.io/crypto-pulse/

## 运行
```bash
cd crypto-dashboard
python3 -m http.server 8000
# 浏览器打开 http://localhost:8000/index.html
```
请通过 http 打开，不要直接双击用 file:// 打开，因为页面需要加载同目录下的 `signals.js` 和 `snapshot.js`。所有接口都是公开接口，不需要 API Key。

## 数据来源
| 模块 | 类型 | 来源 |
|---|---|---|
| BTC/ETH 现货、永续、Mark、Index、基差、资金费率 | **实时** | Binance `api/v3/ticker`、`fapi/v1/premiumIndex`、`fundingRate`；OKX `market/tickers`、`public/mark-price`、`public/funding-rate` |
| 涨幅榜 Top20、1h%、24h 走势 | **实时** | 24h ticker 加真实 1h K 线 |
| WebSocket 推送 | **实时** | Binance `!ticker@arr` / `!markPrice@arr@1s` / 现货 ticker；OKX `ws/v5/public` 的 tickers、mark-price。断线后按 1s→30s 退避重连，WS 断开期间用 REST 每 5s 轮询兜底，另外每 30s 全量刷新一次 |
| 爆仓 | **实时（统计自页面打开起）** | Binance `!forceOrder@arr` 累计；OKX `liquidation-orders`，有 REST 接口和 WS |
| 持仓量 OI | **实时** | Binance `futures/data/openInterestHist`；OKX rubik `open-interest-history` |
| K 线指标（15m/1h/4h/1d 涨幅、连阴/连阳、RSI14、量能倍数） | **实时计算** | klines / candles。只拉取 Top20 和候选币种，接口请求做了限速，结果缓存 60s |
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

## 文件
- `index.html`：主页面
- `signals.js`：信号和指标逻辑，浏览器和 Node 共用
- `snapshot.js`：X 情绪和快讯快照
- `update_sentiment.md`：快照刷新流程
- `test_signals.js`：信号逻辑测试
- `index.mock-v1.html`：第一版纯示例数据页面，作为备份保留

⚠ 仅供参考，不构成投资建议。
