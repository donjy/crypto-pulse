/* 暴涨趋势做多：1h 连阳（趋势）→ 15m 回调（分歧）→ 入场 → 1h/4h 结构止损 → 量价决定激进/保守止盈。
 * 只处理「24h 涨幅榜」里的永续合约。数据为交易所公开 K 线，浏览器 window.Trend，Node require。 */
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
  // 每根 K 线的线性回归斜率
  function slope(v) {
    const n = v.length;
    if (n < 2) return 0;
    const mx = (n - 1) / 2, my = mean(v);
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) { num += (i - mx) * (v[i] - my); den += (i - mx) ** 2; }
    return den ? num / den : 0;
  }
  function fmt(n) {
    if (n == null || !isFinite(n)) return '—';
    if (Math.abs(n) >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
    if (Math.abs(n) >= 1) return n.toLocaleString('en-US', { maximumFractionDigits: 4 });
    if (Math.abs(n) >= 0.001) return n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
    return n.toPrecision(4);
  }

  /**
   * k = { m15, h1, h4 }（升序、含 closed 标记）
   * opt = { price, lev, mmr }
   */
  function analyze(k, opt = {}) {
    const m15 = closed(k.m15), h1 = closed(k.h1), h4 = closed(k.h4);
    if (h1.length < 30 || m15.length < 20 || h4.length < 3) return null;
    const a1 = atr(h1, 14), a15 = atr(m15, 14);
    const last = h1[h1.length - 1];
    const price = opt.price || last.c;
    if (!(price > 0) || !a1 || !a15) return null;

    /* ---------- 拉升结构：从什么时候、涨了多少 ---------- */
    const seg = h1.slice(-168);
    let i0 = 0;
    seg.forEach((c, i) => { if (c.l < seg[i0].l) i0 = i; });
    const legLow = seg[i0].l;
    const legHours = (seg[seg.length - 1].t + 3600e3 - seg[i0].t) / 3600e3;
    const gainFromLow = (price / legLow - 1) * 100;
    const peak = Math.max(...seg.map(c => c.h));
    const drawdown = (price / peak - 1) * 100;

    /* ---------- 1h 趋势 ---------- */
    const c5 = h1.slice(-5);
    const bullCnt = c5.filter(bull).length;
    const gain5 = (price / c5[0].o - 1) * 100;
    let consec = 0;
    for (let i = h1.length - 1; i >= 0; i--) { if (bull(h1[i])) consec++; else break; }
    const qv3 = mean(h1.slice(-3).map(c => c.qv));
    const qv20 = mean(h1.slice(-23, -3).map(c => c.qv)) || 1;
    const volRatio1 = qv3 / qv20;
    const e20 = ema(h1.map(c => c.c), 20) || price;
    const extATR = (price - e20) / a1;
    const slope1 = slope(h1.slice(-6).map(c => c.c)) / a1;
    const body3 = mean(h1.slice(-3).map(c => Math.abs(c.c - c.o) / c.o)) * 100;
    const upperWick3 = mean(h1.slice(-3).map(c => (c.h - Math.max(c.c, c.o)) / (c.h - c.l || 1)));

    /* ---------- 15m 回调：以最近一个高点为起点，量回调段的深度与量能 ---------- */
    const w = m15.slice(-12);
    let hiIdx = 0;
    w.forEach((c, i) => { if (c.h > w[hiIdx].h) hiIdx = i; });
    const swingHigh = w[hiIdx].h;
    const leg = w.slice(hiIdx + 1);                 // 高点之后的回调段
    const noPull = leg.length === 0;
    const pullCandles = noPull ? [w[hiIdx]] : leg;
    const pullLow = Math.min(...pullCandles.map(c => c.l));
    const down = noPull ? 0 : leg.filter(bear).length;
    const pullDepth = noPull ? 0 : (pullLow / swingHigh - 1) * 100;   // 负数
    const depthATR = noPull ? 0 : (pullDepth / 100) * price / a15;    // 负数，单位 ATR
    const baseCandles = w.slice(Math.max(0, hiIdx - 6), hiIdx);
    const volBase = mean(baseCandles.map(c => c.qv)) || mean(w.map(c => c.qv)) || 1;
    const pullVolRatio = noPull ? 1 : mean(pullCandles.map(c => c.qv)) / volBase;
    const reboundATR = noPull ? 0 : (price - pullLow) / a15;
    const slope15 = slope(m15.slice(-5).map(c => c.c)) / a15;
    const reversal = bull(m15[m15.length - 1]);
    const e2015 = ema(m15.map(c => c.c), 20) || price;
    const phase = noPull ? '创新高' : reboundATR < 0.4 ? '回调中' : reboundATR < 1.2 ? '刚反弹' : '已反弹';

    /* ---------- 阶段 ---------- */
    let stage, stageTone;
    if (drawdown <= -12 || (extATR < 0 && gainFromLow > 30)) { stage = '回撤'; stageTone = 'bad'; }
    else if (extATR > 4 || gainFromLow > 90 || legHours > 168) { stage = '末段'; stageTone = 'warn'; }
    else if (gainFromLow > 55 || extATR > 2.8) { stage = '高位'; stageTone = 'warn'; }
    else if (legHours < 10 || gainFromLow < 15) { stage = '启动'; stageTone = 'good'; }
    else { stage = '主升'; stageTone = 'ok'; }

    /* ---------- 条件 ---------- */
    const trendOk = bullCnt >= 3 && gain5 > 1.2 && price > e20;
    const pullOk = leg.length >= 2 && down >= 1 && depthATR <= -0.35 && depthATR >= -4 && pullDepth >= -7 && reboundATR <= 1.5;
    const volHealthy = pullVolRatio <= 1.15;
    const notBroken = price > Math.min(...h1.slice(-4).map(c => c.l));

    /* ---------- 入场 / 止损 / 目标 ---------- */
    const anchor = Math.max(pullLow, Math.min(e2015, price));
    const entryLo = Math.max(anchor - a15 * 0.2, price - a15 * 1.0);
    const entryHi = Math.min(price + a15 * 0.05, entryLo + a15 * 0.5);
    const mid = (entryLo + entryHi) / 2;

    const low2 = Math.min(...h1.slice(-2).map(c => c.l));
    const low6 = Math.min(...h1.slice(-6).map(c => c.l));
    const low4h = Math.min(...h4.slice(-3).map(c => c.l));
    const stopRaw = low6 - a1 * 0.3;
    const broken = stopRaw >= price * 0.999;   // 已跌破 1h 结构，做多逻辑失效
    const stop = broken ? null : stopRaw;
    const risk = stop != null ? mid - stop : null;
    const riskPct = risk != null && risk > 0 ? (risk / mid) * 100 : null;
    const t1 = risk != null && risk > 0 ? mid + risk * 1.5 : null;
    const t2 = risk != null && risk > 0 ? mid + risk * 3.5 : null;

    /* ---------- 止盈模式：量能 + 斜率 ---------- */
    let mode, modeWhy;
    const climax = volRatio1 > 2.5 && upperWick3 > 0.35;
    if (climax) {
      mode = '保守'; modeWhy = '1h 放量且上影线变长，出现冲高回落迹象';
    } else if (pullVolRatio <= 0.95 && slope15 > 0.1) {
      mode = '激进'; modeWhy = '回调缩量、价格仍沿 15m 均线上行，动能充沛';
    } else if (pullVolRatio >= 1.2 || volRatio1 > 1.8) {
      mode = '保守'; modeWhy = '回调放量、或 1h 放量但斜率放缓，上涨动能不足';
    } else {
      mode = '中性'; modeWhy = '量价与斜率都属中性';
    }
    const aggressive = mode === '激进';

    /* ---------- 杠杆 / 强平 ---------- */
    const lev = clamp(opt.lev || 10, 1, 50);
    const mmr = opt.mmr || 0.005;
    const liq = mid * (1 - 1 / lev + mmr);
    const liqDistPct = ((mid - liq) / mid) * 100;
    const maxLev = riskPct ? Math.min(25, Math.max(1, Math.floor(1 / (riskPct / 100 / 0.65 + mmr)))) : 1;
    const levSafe = riskPct != null && riskPct <= liqDistPct * 0.65;

    /* ---------- 风险提示 ---------- */
    const risks = [];
    if (stage === '末段' || stage === '高位') risks.push(`${stage}：已涨 ${gainFromLow.toFixed(0)}%、距起点 ${legHours.toFixed(0)} 小时，追高风险大`);
    if (drawdown <= -8) risks.push(`距 168h 高点回落 ${Math.abs(drawdown).toFixed(1)}%`);
    if (extATR > 3) risks.push(`价格偏离 1h EMA20 达 ${extATR.toFixed(1)} ATR，随时可能均值回归`);
    if (pullVolRatio > 1.5) risks.push(`回调放量 ${pullVolRatio.toFixed(1)}x，分歧明显加大`);
    if (leg.length >= 6 && down >= 4) risks.push(`15m 已回调 ${leg.length} 根（${down} 阴），可能不是回调而是转势`);
    if (price < e20) risks.push('已跌破 1h EMA20');
    if (broken) risks.push('已跌破 1h 近 6 根最低结构，做多逻辑失效');
    if (riskPct != null && riskPct > 6) risks.push(`止损距离 ${riskPct.toFixed(1)}%，单笔风险偏大`);
    if (!levSafe) risks.push('强平距离小于止损距离，杠杆过高');

    /* ---------- 评分 ---------- */
    let score = 0;
    score += clamp(gain5 * 5, 0, 25);
    score += clamp(bullCnt * 3, 0, 15);
    score += volHealthy ? 12 : pullVolRatio < 1.3 ? 6 : 0;
    score += stage === '启动' ? 12 : stage === '主升' ? 16 : stage === '高位' ? 4 : stage === '末段' ? -8 : -18;
    score += mode === '激进' ? 8 : mode === '中性' ? 4 : 0;
    score -= Math.max(0, (extATR - 2.5) * 5);
    score -= Math.max(0, (gainFromLow - 70) * 0.15);
    score = Math.round(clamp(score, 0, 100));
    if (broken) score = Math.min(score, 10);

    const ok = trendOk && pullOk && notBroken && !broken && stage !== '回撤' && riskPct != null && riskPct <= 8;
    const status = ok ? 'entry' : (!broken && stage !== '回撤' && trendOk && (riskPct == null || riskPct <= 8)) ? 'wait' : 'skip';

    /* ---------- 依据 ---------- */
    const reasons = [
      `1h：近 5 根 ${bullCnt} 根阳线，区间 ${gain5 >= 0 ? '+' : ''}${gain5.toFixed(2)}%，${bullCnt >= 4 ? '大阳连续' : '阳线为主'}`,
      `拉升：${legHours.toFixed(0)} 小时前自 ${fmt(legLow)} 启动，至今 ${gainFromLow >= 0 ? '+' : ''}${gainFromLow.toFixed(1)}%，距 168h 高点 ${drawdown.toFixed(1)}%`,
      `15m：从 ${fmt(swingHigh)} 高点回调 ${leg.length} 根（${down} 根阴线）至 ${fmt(pullLow)}，跌幅 ${pullDepth.toFixed(2)}%（${depthATR.toFixed(2)} ATR），当前 ${phase}（离低点 ${reboundATR.toFixed(2)} ATR）`,
      `量能：回调段均量 ${pullVolRatio.toFixed(2)}x（${volHealthy ? '缩量，抛压不大' : '放量，分歧加大'}）`,
      `结构：1h 近 6 根最低 ${fmt(low6)}，4h 近 3 根最低 ${fmt(low4h)}（最后防线 ${(((low4h / mid) - 1) * 100).toFixed(2)}%）`,
      `止盈模式：${mode} —— ${modeWhy}`,
      `杠杆：${lev}x 强平价 ${fmt(liq)}（-${liqDistPct.toFixed(1)}%），止损 -${riskPct ? riskPct.toFixed(1) : '—'}%，${levSafe ? '止损先于强平，安全' : '强平可能先到，建议降杠杆'}`,
      `建议杠杆 ≤ ${maxLev}x`,
    ];

    return {
      ok, status, score, stage, stageTone,
      price, legLow, legHours, gainFromLow, drawdown,
      trend: { bullCnt, gain5, consec, volRatio1, extATR, slope1, body3, upperWick3, e20 },
      pullback: { legLen: leg.length, down, swingHigh, pullLow, pullDepth, depthATR, pullVolRatio, reboundATR, phase, slope15, reversal, e2015 },
      entry: [entryLo, entryHi], stop, low2, low6, low4h, riskPct,
      tp: { mode, aggressive, modeWhy, t1, t2 },
      lev, liq, liqDistPct, maxLev, levSafe,
      risks, reasons,
    };
  }

  const api = { analyze, atr, ema, slope, fmt };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Trend = api;
})(typeof window !== 'undefined' ? window : globalThis);
