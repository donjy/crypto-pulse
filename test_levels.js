/* 用真实交易所数据验证 levels.js：支撑/阻力、成交量分布、盘口大单墙、入场计划。
 * 用法：
 *   node test_levels.js                 # 默认 Binance BTCUSDT
 *   node test_levels.js BTCUSDT         # Binance 合约
 *   node test_levels.js okx BTC-USDT-SWAP
 * 网络受限时会自动改用系统代理（HTTPS_PROXY）通过 curl 取数。 */
const { execFileSync } = require('child_process');
const S = require('./signals.js');
const L = require('./levels.js');

const TFS = { m5: ['5m', 288], m15: ['15m', 288], h1: ['1h', 288], h4: ['4h', 180], d1: ['1d', 180] };

async function getJSON(url) {
  const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.CP_PROXY;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    if (!proxy) throw e;
    const args = ['-sS', '--max-time', '25', '--proxy', proxy, url];
    const out = execFileSync('curl.exe', args, { maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' });
    return JSON.parse(out);
  }
}

async function loadBinance(sym) {
  const ks = {};
  for (const [tf, [iv, lim]] of Object.entries(TFS)) {
    const raw = await getJSON(`https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=${iv}&limit=${lim}`);
    ks[tf] = S.normBinance(raw);
  }
  const d = await getJSON(`https://fapi.binance.com/fapi/v1/depth?symbol=${sym}&limit=500`);
  return { ks, depth: { bids: d.bids, asks: d.asks }, price: +d.bids[0][0] };
}

async function loadOkx(inst) {
  const bars = { m5: '5m', m15: '15m', h1: '1H', h4: '4H', d1: '1Dutc' };
  const ks = {};
  for (const [tf, [iv, lim]] of Object.entries(TFS)) {
    const j = await getJSON(`https://www.okx.com/api/v5/market/candles?instId=${inst}&bar=${bars[tf]}&limit=300`);
    ks[tf] = S.normOkx(j.data).slice(-lim);
  }
  const cv = +(await getJSON('https://www.okx.com/api/v5/public/instruments?instType=SWAP')).data
    .find(x => x.instId === inst)?.ctVal || 1;
  const b = (await getJSON(`https://www.okx.com/api/v5/market/books?instId=${inst}&sz=400`)).data[0];
  return {
    ks,
    depth: { bids: b.bids.map(r => [r[0], +r[1] * cv]), asks: b.asks.map(r => [r[0], +r[1] * cv]) },
    price: +b.bids[0][0],
  };
}

function assert(cond, msg) {
  if (!cond) { console.error('✗ ' + msg); process.exitCode = 1; }
  else console.log('✓ ' + msg);
}

(async () => {
  const platform = (process.argv[2] || 'binance').toLowerCase();
  const sym = process.argv[3] || (platform === 'okx' ? 'BTC-USDT-SWAP' : 'BTCUSDT');
  console.log(`\n== ${platform} ${sym} ==`);
  const { ks, depth, price } = platform === 'okx' ? await loadOkx(sym) : await loadBinance(sym);
  console.log('现价', L.fmtNum(price), '\n');

  const bins = { m5: 28, m15: 30, h1: 30, h4: 26, d1: 24 };
  const an = {};
  for (const tf of Object.keys(TFS)) an[tf] = L.analyze(ks[tf], price, { bins: bins[tf], tf });

  for (const [tf, a] of Object.entries(an)) {
    if (!a) { assert(false, `${tf} 分析失败`); continue; }
    const sup = a.supports[0], res = a.resistances[0];
    const share = a.prof.bins.reduce((s, b) => s + b.share, 0);
    assert(Math.abs(share - 1) < 1e-6, `${tf} 成交量分布占比合计 = 1`);
    const mx = Math.max(...a.prof.bins.map(b => b.qv));
    assert(Math.abs(a.prof.poc.qv - mx) < 1e-6, `${tf} POC 为成交额最大 bin`);
    assert(a.supports.every(l => l.price < price) && a.resistances.every(l => l.price > price), `${tf} 支撑都在现价下方 / 阻力都在上方`);
    console.log(`   ${tf.padEnd(4)} 趋势 ${a.trend >= 0 ? '+' : ''}${a.trend.toFixed(2)}  RSI ${a.rsi?.toFixed(1)}  ATR ${L.fmtNum(a.atr)}  POC ${L.fmtNum(a.prof.poc.mid)}  主动买占比 ${(a.buyRatio * 100).toFixed(0)}%`);
    console.log(`      支撑 ${sup ? `${L.fmtNum(sup.price)} (强度 ${sup.strength}, 距 ${(((sup.price / price) - 1) * 100).toFixed(2)}%)` : '—'}   阻力 ${res ? `${L.fmtNum(res.price)} (强度 ${res.strength}, 距 +${(((res.price / price) - 1) * 100).toFixed(2)}%)` : '—'}`);
  }

  const wl = L.walls(depth, price);
  console.log(`\n盘口 ±${(wl.bandPct * 100).toFixed(0)}%：买 $${(wl.bidSum / 1e6).toFixed(2)}M / 卖 $${(wl.askSum / 1e6).toFixed(2)}M，失衡 ${(wl.imbalance * 100).toFixed(1)}%`);
  console.log('  买墙', wl.bids.map(b => `${L.fmtNum(b.price)} $${(b.usd / 1e6).toFixed(2)}M`).join(' | '));
  console.log('  卖墙', wl.asks.map(b => `${L.fmtNum(b.price)} $${(b.usd / 1e6).toFixed(2)}M`).join(' | '));
  assert(wl.bids.length > 0 && wl.asks.length > 0, '盘口买卖墙都有数据');

  const reso = L.resonance(an, price);
  console.log('\n跨周期共振位：', reso.length ? '' : '（无）');
  reso.forEach(r => console.log(`  ${r.side === 'support' ? '支撑' : '阻力'} ${L.fmtNum(r.price)}  强度 ${r.strength}  ${r.tfs.join('/')}`));

  const pl = L.plan({ price, an, walls: wl, funding: 0.0001 });
  console.log(`\n入场建议：${pl.bias} → ${pl.action}`);
  console.log(`  ${pl.trigger}`);
  console.log(`  ${pl.invalid}`);
  console.log('  依据：\n' + pl.reasons.map(r => '   · ' + r).join('\n'));
  if (pl.entry && pl.stop != null) {
    if (pl.side === 'long') assert(pl.stop < pl.entry[0] && pl.entry[0] <= pl.entry[1] && pl.targets[0] > pl.entry[1], '做多：止损 < 入场区间 < 目标');
    if (pl.side === 'short') assert(pl.stop > pl.entry[1] && pl.entry[0] <= pl.entry[1] && pl.targets[0] < pl.entry[0], '做空：止损 > 入场区间 > 目标');
  }
  assert(pl.reasons.length >= 3, '建议依据至少 3 条');
  console.log('\n完成。');
})().catch(e => { console.error('测试失败：', e.message); process.exit(1); });
