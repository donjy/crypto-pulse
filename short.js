/* 「拉升后回落」做空：候选池 → 涨完确认 → 入场触发 → 风控出场 → 评分/否决。
 * 依据《币安永续合约「拉升后回落」做空策略》四步流水线，只使用币安 USDⓈ-M 公开数据。
 * 浏览器 window.Shorter，Node require。 */
(function (root) {
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const sum = a => a.reduce((s, x) => s + x, 0);
  const mean = a => (a.length ? sum(a) / a.length : 0);
  const closed = ks => (ks || []).filter(k => k.closed);
  const bull = k => k.c > k.o, bear = k => k.c < k.o;

  function ema(v, p) {
    if (v.length < p) return null;
    const k = 2 / (p + 1);
    let e = sum(v.slice(0, p)) / p;
    for (let i = p; i < v.length; i++) e = v[i] * k + e * (1 - k);
    return e;
  }
  function atr(ks, p = 14) {
    if (ks.length < p + 2) return null;
    const tr = [];
    for (let i = 1; i < ks.length; i++) {
      const k = ks[i], q = ks[i - 1];
      tr.push(Math.max(k.h - k.l, Math.abs(k.h - q.c), Math.abs(k.l - q.c)));
    }
    let a = mean(tr.slice(0, p));
    for (let i = p; i < tr.length; i++) a = (a * (p - 1) + tr[i]) / p;
    return a;
  }
  function rsiSeries(closes, p = 14) {
    const out = new Array(closes.length).fill(null);
    if (closes.length < p + 1) return out;
    let g = 0, l = 0;
    for (let i = 1; i <= p; i++) { const d = closes[i] - closes[i - 1]; d > 0 ? g += d : l -= d; }
    g /= p; l /= p;
    out[p] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    for (let i = p + 1; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      g = (g * (p - 1) + Math.max(d, 0)) / p;
      l = (l * (p - 1) + Math.max(-d, 0)) / p;
      out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    }
    return out;
  }
  function vwap(ks) {
    const q = sum(ks.map(k => k.qv || 0));
    if (!q) return null;
    return sum(ks.map(k => ((k.h + k.l + k.c) / 3) * (k.qv || 0))) / q;
  }
  function fmt(n) {
    if (n == null || !isFinite(n)) return '—';
    if (Math.abs(n) >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
    if (Math.abs(n) >= 1) return n.toLocaleString('en-US', { maximumFractionDigits: 4 });
    if (Math.abs(n) >= 0.001) return n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
    return n.toPrecision(4);
  }

  /* ---------- Step 1：候选池（过去 48h 内滚动 24h 涨幅是否够猛） ---------- */
  function candidate(h1, opt = {}) {
    const c = closed(h1);
    if (c.length < 72) return null;
    const win = c.slice(-96);
    const price = opt.price || win[win.length - 1].c;
    let maxRoll = -1e9;
    for (let i = 24; i < win.length; i++) maxRoll = Math.max(maxRoll, (win[i].c / win[i - 24].c - 1) * 100);

    let peakIdx = 0;
    win.forEach((k, i) => { if (k.h > win[peakIdx].h) peakIdx = i; });
    const from = Math.max(0, peakIdx - 48);
    let baseIdx = from;
    for (let i = from; i <= peakIdx; i++) if (win[i].l < win[baseIdx].l) baseIdx = i;
    const peak = Math.max(win[peakIdx].h, price);   // 现价创新高时也算峰值，避免负回吐
    const base = win[baseIdx].l;
    const pumpPct = base > 0 ? (peak / base - 1) * 100 : 0;
    const retrace = peak > base ? clamp((peak - price) / (peak - base), 0, 1.5) : 0;
    const last = win[win.length - 1];
    const sincePeak = (last.t + 3600e3 - win[peakIdx].t) / 3600e3;
    const legHours = (win[peakIdx].t - win[baseIdx].t) / 3600e3;

    const pumpMin = opt.pumpMin || 30;
    const hot = maxRoll >= pumpMin || pumpPct >= pumpMin * 1.15;
    return {
      hot, maxRoll, peak, base, pumpPct, retrace, sincePeak, legHours,
      peakIdx, baseIdx, peakT: win[peakIdx].t, baseT: win[baseIdx].t,
      drawdown: (price / peak - 1) * 100, price, win,
    };
  }

  /* ---------- Step 2–4：状态、评分、入场、风控 ---------- */
  function analyze(d, opt = {}) {
    const c1 = closed(d.h1), c15 = closed(d.m15), c4 = closed(d.h4);
    if (c1.length < 48 || c15.length < 40 || c4.length < 20) return null;
    const d1 = candidate(d.h1, { ...opt, price: d.price });
    if (!d1) return null;
    if (!d1.hot) return { ...d1, stage: 'COLD', ready: false, score: 0, vetoes: [], reasons: ['滚动 24h 涨幅未达到入池阈值'], plan: null };

    const price = d.price || c1[c1.length - 1].c;
    const a1 = atr(c1, 14), a15 = atr(c15, 14), a4 = atr(c4, 14) || a1 * 4;

    /* ---- 1h 结构 ---- */
    const e20h1 = ema(c1.map(k => k.c), 20);
    const e20h1Prev = ema(c1.slice(0, -5).map(k => k.c), 20);
    const e50h1 = ema(c1.map(k => k.c), 50);
    const vw1h = vwap(c1.slice(-24));
    const rsiWin = rsiSeries(d1.win.map(k => k.c), 14);
    const rsiNow = rsiWin[rsiWin.length - 1];
    const rsiPeak = rsiWin[d1.peakIdx] ?? null;

    const last1 = c1[c1.length - 1];
    const last3 = c1.slice(-3);
    const highs3 = last3.map(k => k.h);
    const swingHigh = Math.max(...highs3);
    const swingLow12 = Math.min(...c1.slice(-12, -2).map(k => k.l));
    const volAvg = mean(c1.slice(-24).map(k => k.qv)) || 1;
    const volBreak = mean(c1.slice(-3).map(k => k.qv)) / volAvg;
    const below1h = price < e20h1;
    const ema1Down = e20h1Prev != null && e20h1 < e20h1Prev;
    const dropATR = (e20h1 - price) / a1;

    // lower high / lower low（近 6 根 1h 的高低点重心下移）
    const hh = Math.max(...c1.slice(-6).map(k => k.h));
    const prevHh = Math.max(...c1.slice(-12, -6).map(k => k.h));
    const lowerHigh = hh < prevHh;
    const ll = Math.min(...c1.slice(-3).map(k => k.l));
    const prevLl = Math.min(...c1.slice(-9, -3).map(k => k.l));
    const lowerLow = ll < prevLl;

    // 横盘派发：近 6 根振幅 / ATR 很小
    const range6 = Math.max(...c1.slice(-6).map(k => k.h)) - Math.min(...c1.slice(-6).map(k => k.l));
    const consolidation = range6 < a1 * 1.2;

    /* ---- 4h 大势 ---- */
    const e20h4 = ema(c4.map(k => k.c), 20);
    const e20h4Prev = ema(c4.slice(0, -2).map(k => k.c), 20);
    const below4h = price < e20h4;
    const ema4Down = e20h4Prev != null && e20h4 < e20h4Prev;
    const new4hHigh = c4[c4.length - 1].h >= Math.max(...c4.slice(-13, -1).map(k => k.h));
    const last2_4 = c4.slice(-2);
    const drop2_4 = last2_4.every(bear) && (last2_4[0].o - last2_4[1].c) >= a4 * 1.5;

    /* ---- 15m 触发 ---- */
    const e20h15 = ema(c15.map(k => k.c), 20);
    const e50h15 = ema(c15.map(k => k.c), 50);
    const vw15 = vwap(c15.slice(-96));
    const belowVwap15 = vw15 != null && price < vw15;
    const ema15Bear = e20h15 != null && e50h15 != null && e20h15 < e50h15;

    /* ---- 顶部形态 / 量能 ---- */
    const peakK = d1.win[d1.peakIdx];
    const peakWick = peakK.h > peakK.l ? (peakK.h - Math.max(peakK.o, peakK.c)) / (peakK.h - peakK.l) : 0;
    const peakVolRatio = peakK.qv / (mean(d1.win.slice(Math.max(0, d1.peakIdx - 24), d1.peakIdx).map(k => k.qv)) || peakK.qv);
    const volFade = mean(c1.slice(-6).map(k => k.qv)) / (mean(c1.slice(-24).map(k => k.qv)) || 1);

    /* ---- RSI 顶背离 ---- */
    let rsiDiverge = false, priorHigh = null;
    if (d1.peakIdx > 14) {
      let prevIdx = Math.max(0, d1.peakIdx - 24);
      for (let i = prevIdx; i < d1.peakIdx; i++) if (d1.win[i].h > d1.win[prevIdx].h) prevIdx = i;
      priorHigh = d1.win[prevIdx].h;
      const rsiPrev = rsiWin[prevIdx];
      rsiDiverge = rsiPrev != null && rsiPeak != null && d1.peak > priorHigh && rsiPeak < rsiPrev;
    }

    /* ---- 衍生品 ---- */
    const funding = d.funding != null && isFinite(d.funding) ? d.funding : null;
    let fundingPeak = null;
    if (Array.isArray(d.fundingHist) && d.fundingHist.length) {
      fundingPeak = Math.max(...d.fundingHist.map(x => +x.fundingRate));
    }
    let oiDrop = null, oiNow = null;
    if (Array.isArray(d.oiHist) && d.oiHist.length > 3) {
      const vals = d.oiHist.map(x => +x.sumOpenInterestValue);
      const peakOi = Math.max(...vals);
      oiNow = vals[vals.length - 1];
      oiDrop = peakOi > 0 ? ((peakOi - oiNow) / peakOi) * 100 : null;
    }
    let buyShare = null;
    if (Array.isArray(d.taker) && d.taker.length) {
      const t = d.taker[d.taker.length - 1];
      const b = +t.buyVol, s = +t.sellVol;
      if (b + s > 0) buyShare = b / (b + s) * 100;
    }

    /* ---- 状态机 ---- */
    let stage;
    if (d1.retrace <= 0.03 || new4hHigh || price >= d1.peak * 0.995) stage = 'PUMPING';
    else if (d1.retrace < 0.10) stage = 'TOPPING';
    else if (d1.retrace > 0.62) stage = 'DUMPED';
    else if (below1h && (lowerHigh || lowerLow || ema1Down)) {
      // 是否已经反抽过阻力并失败
      const retestLevels = [e20h1, vw1h, d1.peak - 0.382 * (d1.peak - d1.base)].filter(v => v && v > price);
      const nearLevel = retestLevels.find(v => (v - price) / a1 <= 1.2);
      const rejected = last1 && bear(last1) && (last1.h - Math.max(last1.o, last1.c)) / (last1.h - last1.l || 1) > 0.25;
      stage = (nearLevel && rejected) || (nearLevel && d1.sincePeak >= 6) ? 'RETEST' : 'BREAKDOWN';
    } else stage = 'TOPPING';

    /* ---- 入场 / 止损 / 目标 ---- */
    const levels = [e20h1, vw1h, d1.peak - 0.382 * (d1.peak - d1.base)].filter(v => v && isFinite(v));
    const levelAbove = levels.filter(v => v > price * 1.001).sort((a, b) => a - b)[0];
    const entryRef = stage === 'RETEST' ? (levelAbove || price) : price;
    const entryLo = entryRef - a1 * 0.15;
    const entryHi = entryRef + a1 * 0.15;
    const entryMid = entryRef;
    const awaitRetest = entryRef > price * 1.002;

    const lowerHighPrice = Math.max(...c1.slice(-3).map(k => k.h));
    const stopAnchor = Math.max(lowerHighPrice, entryRef + a1 * 0.2);
    const stop = stopAnchor + a1 * 0.5;
    const risk = stop - entryMid;
    const riskPct = entryMid > 0 ? (risk / entryMid) * 100 : null;
    // 止盈：取「尚未回吐到」的下一档斐波那契，避免目标落在现价上方
    const range = d1.peak - d1.base;
    const nextRatios = [0.382, 0.5, 0.618, 0.786, 1.0].filter(x => x > d1.retrace + 0.04);
    const tp1 = d1.peak - (nextRatios[0] ?? 1.0) * range;
    const tp2 = d1.peak - (nextRatios[1] ?? 1.0) * range;
    const tpBase = d1.base;
    const rr = risk > 0 && tp1 < entryLo ? (entryMid - tp1) / risk : null;

    /* ---- 一票否决 ---- */
    const vetoes = [];
    const qv = d.qv ?? opt.qv ?? 0;
    if (qv && qv < 20e6) vetoes.push('24h 成交额 < 2000 万');
    if (d.onboardDays != null && d.onboardDays < 14) vetoes.push(`上线不足 14 天（${Math.round(d.onboardDays)} 天）`);
    if (new4hHigh) vetoes.push('4h 仍在创新高');
    if (d1.retrace > 0.6) vetoes.push('回吐比例 > 60%');
    if (funding != null && funding <= -0.0005) vetoes.push('资金费率极负，空头拥挤');
    if (d.btcStrong) vetoes.push('BTC 1h 强势拉升，做空逆风');

    /* ---- 评分（满分 100，权重按文档） ---- */
    const sPump = clamp((d1.pumpPct - 15) / 9, 0, 8) + (qv >= 1e9 ? 2 : qv >= 2e8 ? 1 : 0);       // 10
    const sTop = clamp(peakWick * 8, 0, 4) + clamp((peakVolRatio - 1) * 3, 0, 4)
      + clamp((rsiPeak || 0) > 70 && rsiDiverge ? 5 : 0, 0, 5) + clamp((oiDrop || 0) / 5, 0, 5) + 2; // 20
    const sTrend = (below4h ? 7 : 0) + (ema4Down ? 4 : 0) + (lowerHigh ? 5 : 0)
      + (below1h ? 5 : 0) + ((ema15Bear && belowVwap15) ? 4 : 0);                                  // 25
    const sDeriv = clamp(((oiDrop || 0) - 5) / 1.25, 0, 8)
      + clamp(((fundingPeak || 0) - (funding || 0)) * 2000, 0, 6) + (buyShare != null ? clamp((55 - buyShare) * 0.6, 0, 6) : 0); // 20
    const sEntry = clamp(((rr || 0) - 1) * 7, 0, 10) + ((entryRef - price) / a1 <= 1.2 ? 5 : 2);  // 15
    const sLiq = (qv >= 1e9 ? 6 : qv >= 2e8 ? 4 : 2)
      + (d.onboardDays != null && d.onboardDays >= 30 ? 2 : 0) - (d.btcStrong ? 4 : 0) - (d1.retrace > 0.5 ? 3 : 0); // 10
    let score = Math.round(clamp(sPump + sTop + sTrend + sDeriv + sEntry + sLiq, 0, 100));

    const ready = stage === 'RETEST' || stage === 'BREAKDOWN';
    const chase = stage === 'BREAKDOWN' && dropATR > 2.2;   // 已经跌离 EMA20 太远，不追空
    const nearEntry = !awaitRetest || (entryRef - price) <= a1 * 0.8;  // 反抽位太远就先观察
    const canEnter = ready && !chase && nearEntry && vetoes.length === 0 && rr != null && rr >= 1.8 && riskPct != null && riskPct <= 10 && below1h;
    score = clamp(score, 0, 100);
    if (vetoes.length) score = Math.min(score, 45);

    /* ---- 触发理由 ---- */
    const triggers = [];
    if (lowerHigh) triggers.push('1h 高点下移');
    if (lowerLow) triggers.push('低点下移');
    if (below1h) triggers.push(`1h 收盘在 EMA20(${fmt(e20h1)}) 下方`);
    if (ema1Down) triggers.push('1h EMA20 拐头向下');
    if (below4h) triggers.push(`4h 收于 EMA20(${fmt(e20h4)}) 下方`);
    if (ema4Down) triggers.push('4h EMA20 下行');
    if (new4hHigh) triggers.push('4h 仍在创新高');
    if (stage === 'RETEST') triggers.push('反抽 EMA20/VWAP 受阻');
    if (volBreak >= 1.5) triggers.push(`破位放量 ${volBreak.toFixed(1)}x`);
    if (oiDrop != null && oiDrop >= 10) triggers.push(`OI 自峰值 -${oiDrop.toFixed(0)}%`);
    if (buyShare != null) triggers.push(`主动买占比 ${buyShare.toFixed(0)}%`);
    if (rsiDiverge) triggers.push('RSI 顶背离');
    if (peakWick > 0.35) triggers.push(`峰值长上影 ${(peakWick * 100).toFixed(0)}%`);

    const reasons = [
      `拉升：${d1.legHours.toFixed(0)}h 从 ${fmt(d1.base)} 到 ${fmt(d1.peak)}（+${d1.pumpPct.toFixed(0)}%），距峰值 ${d1.sincePeak.toFixed(0)}h`,
      `回落：回吐 ${(d1.retrace * 100).toFixed(1)}%（现价 ${fmt(price)}，距峰值 ${d1.sincePeak.toFixed(0)}h）`,
      `结构：${lowerHigh ? '高点下移' : '高点未破'}、${lowerLow ? '低点下移' : '低点未破'}；1h EMA20 ${fmt(e20h1)}、4h EMA20 ${fmt(e20h4)}`,
      `衍生品：资金费率 ${funding == null ? '—' : (funding * 100).toFixed(4) + '%'}${fundingPeak != null ? `（峰值 ${(fundingPeak * 100).toFixed(4)}%）` : ''}，OI ${oiDrop == null ? '—' : '-' + oiDrop.toFixed(0) + '%'}，主动买 ${buyShare == null ? '—' : buyShare.toFixed(0) + '%'}`,
      `计划：入场 ${fmt(entryLo)}–${fmt(entryHi)}，止损 ${fmt(stop)}（+${riskPct == null ? '—' : riskPct.toFixed(1)}%），TP1 ${fmt(tp1)} / TP2 ${fmt(tp2)} / 起涨平台 ${fmt(tpBase)}，RR ${rr == null ? '—' : rr.toFixed(2)}`,
    ];
    if (chase) reasons.push(`追空警示：现价已低于 1h EMA20 ${dropATR.toFixed(1)} ATR，等反抽到 EMA20 附近再考虑`);
    if (!nearEntry) reasons.push(`反抽位 ${fmt(entryRef)} 距现价还有 ${((entryRef - price) / a1).toFixed(1)} ATR，先观察等价格回到入场区`);
    if (vetoes.length) reasons.push('一票否决：' + vetoes.join('；'));

    return {
      ...d1, stage, ready, canEnter, chase, nearEntry, dropATR, score, vetoes, reasons, triggers,
      plan: {
        entry: [entryLo, entryHi], entryRef, awaitRetest, stop, riskPct, rr,
        tp1, tp2, base: tpBase, type: stage === 'RETEST' ? 'B 反抽失败' : stage === 'BREAKDOWN' ? 'A 破位' : '—',
      },
      metrics: {
        e20h1, e20h4, vw1h, vw15, a1, rsiNow, rsiPeak, rsiDiverge, peakWick, peakVolRatio, volFade,
        volBreak, oiDrop, oiNow, funding, fundingPeak, buyShare, below1h, below4h, ema4Down, lowerHigh, lowerLow,
        consolidation, new4hHigh, ema15Bear, belowVwap15,
      },
      parts: { sPump, sTop, sTrend, sDeriv, sEntry, sLiq },
    };
  }

  const api = { candidate, analyze, ema, atr, rsiSeries, vwap, fmt };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Shorter = api;
})(typeof window !== 'undefined' ? window : globalThis);
