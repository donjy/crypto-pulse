/* 用真实涨幅榜数据验证 trend.js（暴涨趋势做多：1h 连阳 + 15m 回调）。
 * 用法：node test_trend.js [binance|okx] [杠杆=10]
 * 网络受限时自动走 HTTPS_PROXY 的 curl。 */
const { execFileSync } = require('child_process');
const S = require('./signals.js');
const T = require('./trend.js');

async function getJSON(url) {
  const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.CP_PROXY;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    if (!proxy) throw e;
    const out = execFileSync('curl.exe', ['-sS', '--max-time', '25', '--proxy', proxy, url], { maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' });
    return JSON.parse(out);
  }
}

function assert(cond, msg) {
  if (!cond) { console.error('✗ ' + msg); process.exitCode = 1; } else console.log('✓ ' + msg);
}

(async () => {
  const platform = (process.argv[2] || 'binance').toLowerCase();
  const lev = +(process.argv[3] || 10);
  console.log(`\n== ${platform} 涨幅榜 · 杠杆 ${lev}x ==`);

  let uni;
  if (platform === 'okx') {
    const d = (await getJSON('https://www.okx.com/api/v5/market/tickers?instType=SWAP')).data;
    uni = d.filter(x => x.instId.endsWith('-USDT-SWAP'))
      .map(x => ({ id: x.instId, chg: (+x.last / +x.open24h - 1) * 100, qv: +x.volCcy24h * +x.last }))
      .filter(x => x.chg >= 8 && x.qv > 3e6).sort((a, b) => b.chg - a.chg).slice(0, 12);
  } else {
    const d = await getJSON('https://fapi.binance.com/fapi/v1/ticker/24hr');
    uni = d.filter(x => x.symbol.endsWith('USDT'))
      .map(x => ({ id: x.symbol, chg: +x.priceChangePercent, qv: +x.quoteVolume }))
      .filter(x => x.chg >= 8 && x.qv > 3e6).sort((a, b) => b.chg - a.chg).slice(0, 12);
  }
  console.log('候选：' + uni.map(x => `${x.id} ${x.chg.toFixed(1)}%`).join(' | ') + '\n');

  const rows = [];
  for (const u of uni) {
    let ks;
    if (platform === 'okx') {
      const bars = { '15m': '15m', '1h': '1H', '4h': '4H' };
      ks = {};
      for (const tf of ['15m', '1h', '4h']) {
        const j = await getJSON(`https://www.okx.com/api/v5/market/candles?instId=${u.id}&bar=${bars[tf]}&limit=300`);
        ks[{ '15m':'m15', '1h':'h1', '4h':'h4' }[tf]] = S.normOkx(j.data).slice(-(tf === '15m' ? 96 : 200));
      }
    } else {
      const [m15, h1, h4] = await Promise.all([
        getJSON(`https://fapi.binance.com/fapi/v1/klines?symbol=${u.id}&interval=15m&limit=96`),
        getJSON(`https://fapi.binance.com/fapi/v1/klines?symbol=${u.id}&interval=1h&limit=200`),
        getJSON(`https://fapi.binance.com/fapi/v1/klines?symbol=${u.id}&interval=4h&limit=60`),
      ]);
      ks = { m15: S.normBinance(m15), h1: S.normBinance(h1), h4: S.normBinance(h4) };
    }
    const a = T.analyze(ks, { price: ks.m15[ks.m15.length - 1].c, lev });
    if (!a) { console.log(`  ${u.id}: 数据不足`); continue; }
    rows.push({ id: u.id, chg: u.chg, ...a });
  }

  rows.sort((a, b) => b.score - a.score);
  for (const r of rows) {
    console.log(`${r.ok ? '★' : ' '} ${r.id.padEnd(14)} ${String(r.chg.toFixed(1) + '%').padStart(7)}  ${r.stage}  score ${String(r.score).padStart(3)}`);
    console.log(`   拉升 ${r.legHours.toFixed(0)}h +${r.gainFromLow.toFixed(1)}% · 1h ${r.trend.bullCnt}/5 阳 · 15m 回调 ${r.pullback.legLen} 根/${r.pullback.down} 阴 ${r.pullback.pullDepth.toFixed(2)}% 量 ${r.pullback.pullVolRatio.toFixed(2)}x · ${r.tp.mode}`);
    console.log(`   入场 ${T.fmt(r.entry[0])}–${T.fmt(r.entry[1])}  止损 ${T.fmt(r.stop)} (-${r.riskPct?.toFixed(2)}%)  目标 ${T.fmt(r.tp.t1)} / ${T.fmt(r.tp.t2)}  强平 ${T.fmt(r.liq)} (${r.lev}x)`);
    if (r.risks.length) console.log('   风险：' + r.risks.join('；'));
  }

  const ok = rows.filter(r => r.ok);
  console.log(`\n符合条件 ${ok.length}/${rows.length}`);
  assert(rows.length > 0, '至少分析了 1 个涨幅榜币种');
  if (ok.length) {
    const r = ok[0];
    assert(r.entry[0] < r.entry[1] && r.entry[0] < r.price, `入场区间合理（${T.fmt(r.entry[0])}–${T.fmt(r.entry[1])}）`);
    assert(r.stop < r.entry[0], '止损在入场区间下方');
    assert(r.tp.t1 > r.entry[1] && r.tp.t2 > r.tp.t1, '保守目标 < 激进目标，且在入场上方');
    assert(r.riskPct > 0 && r.riskPct < 15, '单笔风险比例在合理范围');
    assert(r.levSafe ? r.stop > r.liq : true, '杠杆安全时止损先于强平');
    assert(r.stage !== '回撤', '入选标的不处于回撤阶段');
  }
  console.log('\n完成。');
})().catch(e => { console.error('测试失败：', e.message); process.exit(1); });
