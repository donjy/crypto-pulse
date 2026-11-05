// node test_signals.js [binance|okx] — runs the real scan against public endpoints
const S = require('./signals.js');
const plat = process.argv[2] || 'binance';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function j(u) { const r = await fetch(u); if (!r.ok) throw new Error(r.status + ' ' + u); return r.json(); }
async function universe() {
  if (plat === 'binance') {
    const t = await j('https://fapi.binance.com/fapi/v1/ticker/24hr');
    return t.filter(x => x.symbol.endsWith('USDT')).sort((a, b) => b.quoteVolume - a.quoteVolume).slice(0, 80).map(x => ({ sym: x.symbol, chg: +x.priceChangePercent }));
  }
  const t = (await j('https://www.okx.com/api/v5/market/tickers?instType=SWAP')).data;
  return t.filter(x => x.instId.endsWith('-USDT-SWAP')).map(x => ({ sym: x.instId, qv: +x.volCcy24h * +x.last, chg: (x.last / x.open24h - 1) * 100 })).sort((a, b) => b.qv - a.qv).slice(0, 80);
}
async function kl(sym, tf) {
  if (plat === 'binance') return S.normBinance(await j(`https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=${tf}&limit=60`));
  const bar = { '15m': '15m', '1h': '1H', '4h': '4H', '1d': '1Dutc' }[tf];
  return S.normOkx((await j(`https://www.okx.com/api/v5/market/candles?instId=${sym}&bar=${bar}&limit=60`)).data);
}
(async () => {
  const u = await universe(); const out = [];
  for (const x of u) {
    try {
      const k = { m15: await kl(x.sym, '15m'), h1: await kl(x.sym, '1h'), h4: await kl(x.sym, '4h'), d1: await kl(x.sym, '1d') };
      for (const side of ['long', 'short']) { const e = S.evaluate(k, { side }); if (e.match) out.push({ side, sym: x.sym, score: e.score, d1: e.d1.ret.toFixed(2), h4: e.h4.ret.toFixed(2), h1: e.h1.ret.toFixed(2), down15: e.m15.ret.toFixed(2), rsi15: e.rsi15?.toFixed(1) }); }
      await sleep(plat === 'okx' ? 120 : 30);
    } catch (e) { console.error(x.sym, e.message); }
  }
  console.log(new Date().toString(), plat, 'scanned', u.length);
  console.table(out.sort((a, b) => b.score - a.score));
})();
