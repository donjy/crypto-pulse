/* 用真实币安数据验证 short.js（拉升后回落做空）。
 * 用法：node test_short.js [pumpMin=30] [universe=80]
 * 网络受限时自动走 HTTPS_PROXY 的 curl。 */
const { execFileSync } = require('child_process');
const S = require('./signals.js');
const SH = require('./short.js');

const BASE = 'https://fapi.binance.com';
async function getJSON(url) {
  const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.CP_PROXY;
  if (proxy) {
    const out = execFileSync('curl.exe', ['-sS', '--connect-timeout', '10', '--max-time', '30', '--proxy', proxy, url], { maxBuffer: 128 * 1024 * 1024, encoding: 'utf8' });
    return JSON.parse(out);
  }
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
const K = (sym, tf, lim) => getJSON(`${BASE}/fapi/v1/klines?symbol=${sym}&interval=${tf}&limit=${lim}`).then(S.normBinance);
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try { out[i] = await fn(items[i], i); } catch { out[i] = null; }
    }
  }));
  return out;
}
function assert(cond, msg) {
  if (!cond) { console.error('✗ ' + msg); process.exitCode = 1; } else console.log('✓ ' + msg);
}

(async () => {
  const pumpMin = +(process.argv[2] || 30);
  const universeN = +(process.argv[3] || 80);
  console.log(`\n== Binance 拉升后回落做空 · pumpMin=${pumpMin}% · universe=${universeN} ==`);

  const [info, tickers] = await Promise.all([getJSON(`${BASE}/fapi/v1/exchangeInfo`), getJSON(`${BASE}/fapi/v1/ticker/24hr`)]);
  const perp = new Map(info.symbols.filter(s => s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT' && s.status === 'TRADING')
    .map(s => [s.symbol, s]));
  const now = Date.now();
  const tk = new Map(tickers.map(t => [t.symbol, t]));
  const uni = [...perp.keys()]
    .map(sym => ({ sym, qv: +tk.get(sym)?.quoteVolume || 0, chg: +tk.get(sym)?.priceChangePercent || 0, last: +tk.get(sym)?.lastPrice || 0 }))
    .filter(x => x.qv >= 20e6)
    .sort((a, b) => b.qv - a.qv).slice(0, universeN);
  console.log(`扫描 ${uni.length} 个 USDT 永续（按成交额）…`);

  const btc = await K('BTCUSDT', '1h', 48);
  const btcEma = SH.ema(btc.filter(k => k.closed).map(k => k.c), 20);
  const btcLast3 = btc.filter(k => k.closed).slice(-3);
  const btcGain = (btcLast3[2].c / btcLast3[0].o - 1) * 100;
  const btcStrong = btcGain > 1.5 && btcLast3[2].c > btcEma;
  console.log(`BTC 1h 近 3 根 ${btcGain.toFixed(2)}% · 强势=${btcStrong}`);

  const cands = [];
  let scanned = 0;
  const hits = await mapLimit(uni, 5, async u => {
    const h1 = await K(u.sym, '1h', 96);
    const c = SH.candidate(h1, { price: u.last, pumpMin });
    return c && c.hot ? { ...u, h1, c } : null;
  });
  hits.filter(Boolean).forEach(h => cands.push(h));
  console.log(`\n入池 ${cands.length} 个：` + cands.map(c => `${c.sym} ${c.c.pumpPct.toFixed(0)}%`).join(' | ') + '\n');

  const rows = [];
  const analyzed = await mapLimit(cands, 4, async c => {
    const [m15, h4, oiHist, taker, fundHist, prem] = await Promise.all([
      K(c.sym, '15m', 96), K(c.sym, '4h', 60),
      getJSON(`${BASE}/futures/data/openInterestHist?symbol=${c.sym}&period=4h&limit=30`),
      getJSON(`${BASE}/futures/data/takerlongshortRatio?symbol=${c.sym}&period=1h&limit=24`),
      getJSON(`${BASE}/fapi/v1/fundingRate?symbol=${c.sym}&limit=30`),
      getJSON(`${BASE}/fapi/v1/premiumIndex?symbol=${c.sym}`),
    ]);
    const onboardDays = (now - +perp.get(c.sym).onboardDate) / 864e5;
    const a = SH.analyze({
      symbol: c.sym, h1: c.h1, m15, h4, qv: c.qv, price: c.last,
      oiHist, taker, fundingHist: fundHist, funding: +prem.lastFundingRate, onboardDays, btcStrong,
    }, { pumpMin });
    return a && a.plan ? { ...a, sym: c.sym, chg: c.chg } : null;
  });
  analyzed.filter(Boolean).forEach(r => rows.push(r));

  rows.sort((a, b) => (b.canEnter - a.canEnter) || (b.score - a.score));
  for (const r of rows) {
    const p = r.plan;
    console.log(`${r.canEnter ? '★' : ' '} ${r.sym.padEnd(14)} ${String(r.chg.toFixed(1) + '%').padStart(7)}  ${r.stage.padEnd(10)} score ${String(r.score).padStart(3)}  pump ${r.pumpPct.toFixed(0)}%  回吐 ${(r.retrace * 100).toFixed(0)}%`);
    console.log(`   入场 ${SH.fmt(p.entry[0])}–${SH.fmt(p.entry[1])}  止损 ${SH.fmt(p.stop)} (+${p.riskPct?.toFixed(1)}%)  TP1 ${SH.fmt(p.tp1)} / TP2 ${SH.fmt(p.tp2)} / 平台 ${SH.fmt(p.base)}  RR ${p.rr?.toFixed(2)}`);
    console.log(`   OI ${r.metrics.oiDrop == null ? '—' : '-' + r.metrics.oiDrop.toFixed(0) + '%'}  费率 ${r.metrics.funding == null ? '—' : (r.metrics.funding * 100).toFixed(4) + '%'}  主动买 ${r.metrics.buyShare == null ? '—' : r.metrics.buyShare.toFixed(0) + '%'}  ${r.vetoes.length ? '否决：' + r.vetoes.join('；') : ''}`);
  }

  const ok = rows.filter(r => r.canEnter);
  console.log(`\n可入场 ${ok.length}/${rows.length}`);
  assert(rows.length > 0, '至少有 1 个候选进入分析');
  if (ok.length) {
    const r = ok[0], p = r.plan;
    assert(p.entry[0] < p.entry[1], '入场区间有效');
    assert(p.stop > p.entry[1], '止损在入场区间上方（做空）');
    assert(p.tp1 < p.entry[0] && p.tp2 < p.tp1, 'TP1 / TP2 逐级向下');
    assert(p.rr > 1.8, '盈亏比 > 1.8');
    assert(['BREAKDOWN', 'RETEST'].includes(r.stage), '可入场状态为破位/反抽失败');
    assert(r.vetoes.length === 0, '可入场不带一票否决');
  }
  console.log('\n完成。');
})().catch(e => { console.error('测试失败：', e.message); process.exit(1); });
