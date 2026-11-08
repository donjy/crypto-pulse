/* 多周期关键价位：成交量分布（POC/价值区/密集区）、摆动高低点聚类、盘口大单墙、入场计划。
 * 数据全部来自交易所公开一手接口（K 线与订单簿），浏览器 window.Levels，Node require。 */
(function (root) {
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const sum = a => a.reduce((s, x) => s + x, 0);
  const median = a => { const s = a.slice().sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

  function fmtNum(n) {
    if (n == null || !isFinite(n)) return '—';
    if (Math.abs(n) >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
    if (Math.abs(n) >= 1) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
    if (Math.abs(n) >= 0.001) return n.toFixed(5).replace(/0+$/, '').replace(/\.$/, '');
    return n.toPrecision(4);
  }

  function ema(values, p) {
    if (values.length < p) return null;
    const k = 2 / (p + 1);
    let e = sum(values.slice(0, p)) / p;
    for (let i = p; i < values.length; i++) e = values[i] * k + e * (1 - k);
    return e;
  }

  function atr(ks, p = 14) {
    if (ks.length < p + 2) return null;
    const trs = [];
    for (let i = 1; i < ks.length; i++) {
      const k = ks[i], prev = ks[i - 1];
      trs.push(Math.max(k.h - k.l, Math.abs(k.h - prev.c), Math.abs(k.l - prev.c)));
    }
    let a = sum(trs.slice(0, p)) / p;
    for (let i = p; i < trs.length; i++) a = (a * (p - 1) + trs[i]) / p;
    return a;
  }

  function rsi(closes, p = 14) {
    if (closes.length < p + 1) return null;
    let g = 0, l = 0;
    for (let i = 1; i <= p; i++) { const d = closes[i] - closes[i - 1]; d > 0 ? g += d : l -= d; }
    g /= p; l /= p;
    for (let i = p + 1; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      g = (g * (p - 1) + Math.max(d, 0)) / p;
      l = (l * (p - 1) + Math.max(-d, 0)) / p;
    }
    return l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }

  /* ---------- 成交量分布：把每根 K 线的成交额按价格区间摊到 bin 上 ---------- */
  function profile(ks, bins = 30) {
    let lo = Infinity, hi = -Infinity;
    for (const k of ks) { if (k.l < lo) lo = k.l; if (k.h > hi) hi = k.h; }
    if (!isFinite(lo) || !isFinite(hi) || hi <= lo) return null;
    const step = (hi - lo) / bins;
    const arr = Array.from({ length: bins }, (_, i) => ({
      i, lo: lo + i * step, hi: lo + (i + 1) * step, mid: lo + (i + 0.5) * step,
      qv: 0, buy: 0, sell: 0,
    }));
    for (const k of ks) {
      const i0 = clamp(Math.floor((k.l - lo) / step), 0, bins - 1);
      const i1 = clamp(Math.floor((k.h - lo) / step), 0, bins - 1);
      const n = i1 - i0 + 1, per = (k.qv || 0) / n;
      const rng = k.h - k.l || 1;
      const buyShare = clamp((k.c - k.l) / rng, 0, 1); // 收在区间上半部 → 主动买占比高
      for (let i = i0; i <= i1; i++) { arr[i].qv += per; arr[i].buy += per * buyShare; arr[i].sell += per * (1 - buyShare); }
    }
    const total = sum(arr.map(b => b.qv)) || 1;
    arr.forEach(b => { b.share = b.qv / total; });
    let poc = arr[0];
    arr.forEach(b => { if (b.qv > poc.qv) poc = b; });
    // 70% 价值区：从 POC 向两侧按成交量逐格扩张
    const idx = [poc.i];
    let acc = poc.qv;
    while (acc / total < 0.7 && idx.length < bins) {
      const l = arr[idx[0] - 1], r = arr[idx[idx.length - 1] + 1];
      if (!l && !r) break;
      if (r && (!l || r.qv >= l.qv)) { idx.push(r.i); acc += r.qv; } else { idx.unshift(l.i); acc += l.qv; }
    }
    return {
      bins: arr, lo, hi, step, total, poc,
      vaLo: arr[Math.min(...idx)].lo, vaHi: arr[Math.max(...idx)].hi,
    };
  }

  /* ---------- 摆动高低点（分形）---------- */
  function pivots(ks, L = 3, R = 3) {
    const out = [];
    for (let i = L; i < ks.length - R; i++) {
      let isH = true, isL = true;
      for (let j = i - L; j <= i + R; j++) {
        if (j === i) continue;
        if (ks[j].h >= ks[i].h) isH = false;
        if (ks[j].l <= ks[i].l) isL = false;
        if (!isH && !isL) break;
      }
      if (isH) out.push({ price: ks[i].h, t: ks[i].t, kind: 'high' });
      if (isL) out.push({ price: ks[i].l, t: ks[i].t, kind: 'low' });
    }
    return out;
  }

  /* ---------- 邻近价位聚类 ---------- */
  function cluster(pts, tolRel) {
    const sorted = pts.slice().sort((a, b) => a.price - b.price);
    const groups = [];
    for (const p of sorted) {
      const g = groups[groups.length - 1];
      if (g && (p.price - g.last) / g.last <= tolRel) { g.items.push(p); g.last = p.price; }
      else groups.push({ items: [p], last: p.price });
    }
    return groups.map(g => ({
      price: sum(g.items.map(x => x.price)) / g.items.length,
      touches: g.items.length,
      highs: g.items.filter(x => x.kind === 'high').length,
      lows: g.items.filter(x => x.kind === 'low').length,
      lastT: Math.max(...g.items.map(x => x.t)),
    }));
  }

  /* ---------- 单个周期的完整分析 ---------- */
  function analyze(ks, price, opt = {}) {
    if (!ks || ks.length < 30 || !(price > 0)) return null;
    const bins = opt.bins || 30;
    const prof = profile(ks, bins);
    if (!prof) return null;
    const a = atr(ks, 14) || price * 0.005;
    const tolRel = clamp((a / price) * 0.9, 0.0012, 0.008);
    const piv = pivots(ks, opt.L || 3, opt.R || 3);
    const cl = cluster(piv, tolRel);
    const med = median(prof.bins.map(b => b.qv)) || 1;

    const levels = [];
    const bandOf = p => prof.bins.filter(b => b.mid >= p * (1 - tolRel) && b.mid <= p * (1 + tolRel));
    for (const c of cl) {
      const band = bandOf(c.price);
      const qv = sum(band.map(b => b.qv));
      const buy = sum(band.map(b => b.buy));
      const sell = sum(band.map(b => b.sell));
      const share = qv / prof.total;
      const nearPoc = Math.abs(c.price - prof.poc.mid) / price <= tolRel * 1.3;
      levels.push({
        price: c.price, touches: c.touches, share, qv, buy, sell,
        buyRatio: buy + sell ? buy / (buy + sell) : 0.5,
        nearPoc, src: 'swing', lastT: c.lastT, strength: 0,
      });
    }
    // 成交量密集区（HVN）也作为价位，即使没有摆动点
    for (const b of prof.bins) {
      if (b.qv < med * 1.9) continue;
      if (levels.some(l => Math.abs(l.price - b.mid) / price <= tolRel)) continue;
      levels.push({
        price: b.mid, touches: 0, share: b.share, qv: b.qv, buy: b.buy, sell: b.sell,
        buyRatio: b.buy + b.sell ? b.buy / (b.buy + b.sell) : 0.5,
        nearPoc: b.i === prof.poc.i, src: 'volume', lastT: null, strength: 0,
      });
    }
    // 强度归一化：同一周期内按「被触碰次数」和「成交量占比」相对最强值打分
    const maxTouches = Math.max(1, ...levels.map(l => l.touches));
    const maxShare = Math.max(1e-9, ...levels.map(l => l.share));
    levels.forEach(l => {
      l.strength = Math.round(clamp(18 + 42 * (l.touches / maxTouches) + 38 * Math.sqrt(l.share / maxShare) + (l.nearPoc ? 6 : 0), 5, 97));
    });
    // 合并过近的价位，保留更强者
    levels.sort((x, y) => x.price - y.price);
    const merged = [];
    for (const l of levels) {
      const prev = merged[merged.length - 1];
      if (prev && (l.price - prev.price) / price <= tolRel * 0.8) {
        if (l.strength > prev.strength) {
          l.touches += prev.touches; l.share += prev.share; l.qv += prev.qv;
          merged[merged.length - 1] = l;
        } else {
          prev.touches += l.touches; prev.share += l.share; prev.qv += l.qv;
        }
      } else merged.push(l);
    }

    const eps = price * 0.0004;
    const supports = merged.filter(l => l.price < price - eps).sort((x, y) => y.price - x.price).slice(0, 3);
    const resistances = merged.filter(l => l.price > price + eps).sort((x, y) => x.price - y.price).slice(0, 3);
    // 区间边缘兜底：没有摆动点时，用可见区间的下沿/上沿（弱强度）
    const edge = (p, side) => ({ price: p, touches: 0, share: 0, buy: 0, sell: 0, buyRatio: 0.5, nearPoc: false, src: 'range', lastT: null, strength: 30, side });
    if (!supports.length && prof.lo < price * 0.9992) supports.push(edge(prof.lo, 'support'));
    if (!resistances.length && prof.hi > price * 1.0008) resistances.push(edge(prof.hi, 'resistance'));

    const closes = ks.map(k => k.c);
    const e20 = ema(closes, 20), e50 = ema(closes, 50);
    let trend = 0;
    if (e20 != null && e50 != null) {
      if (price > e20 && e20 > e50) trend = 1;
      else if (price < e20 && e20 < e50) trend = -1;
      else trend = (price > e20 ? 0.4 : -0.4) + (e20 > e50 ? 0.3 : -0.3);
    }
    const lastN = ks.slice(-Math.min(24, ks.length));
    const nb = sum(lastN.map(k => k.qv * (k.h > k.l ? (k.c - k.l) / (k.h - k.l) : 0.5)));
    const nq = sum(lastN.map(k => k.qv)) || 1;

    return {
      tf: opt.tf || '', prof, atr: a, levels: merged, supports, resistances,
      rsi: rsi(closes), ema20: e20, ema50: e50, trend,
      buyRatio: nb / nq,
      price,
    };
  }

  /* ---------- 盘口：近 N% 内的大单墙（真实挂单，USD 计价）---------- */
  function walls(depth, price, opt = {}) {
    if (!depth || !price) return null;
    const bandPct = opt.bandPct || 0.03;
    const bucketRel = opt.bucketRel || 0.0012;
    const bucket = price * bucketRel;
    const agg = list => {
      const m = new Map();
      for (const row of list) {
        const p = +row[0], q = +row[1];
        if (!(p > 0) || !(q > 0)) continue;
        if (Math.abs(p / price - 1) > bandPct) continue;
        const b = Math.floor(p / bucket);
        const o = m.get(b) || { notional: 0, qty: 0, n: 0 };
        o.notional += p * q; o.qty += q; o.n++;
        m.set(b, o);
      }
      return [...m.values()]
        .map(o => { const p = o.notional / o.qty; return { price: p, usd: o.notional, qty: o.qty, n: o.n, dist: (p / price - 1) * 100 }; })
        .sort((x, y) => y.usd - x.usd);
    };
    const bids = agg(depth.bids || []), asks = agg(depth.asks || []);
    const bs = sum((depth.bids || []).map(r => +r[0] * +r[1]));
    const as = sum((depth.asks || []).map(r => +r[0] * +r[1]));
    return {
      bids: bids.slice(0, 3), asks: asks.slice(0, 3),
      bidSum: bs, askSum: as,
      imbalance: bs + as ? (bs - as) / (bs + as) : 0,
      bandPct,
    };
  }

  /* ---------- 跨周期共振位 ---------- */
  function resonance(ans, price, opt = {}) {
    const tolRel = opt.tolRel || 0.0035;
    const pts = [];
    for (const [tf, a] of Object.entries(ans)) {
      if (!a) continue;
      for (const l of a.levels) pts.push({ tf, price: l.price, strength: l.strength, touches: l.touches });
    }
    pts.sort((x, y) => x.price - y.price);
    const groups = [];
    for (const p of pts) {
      const g = groups[groups.length - 1];
      if (g && (p.price - g.price0) / g.price0 <= tolRel) { g.items.push(p); g.last = p.price; }
      else groups.push({ items: [p], last: p.price, price0: p.price });
    }
    const raw = groups
      .map(g => {
        const tfs = [...new Set(g.items.map(x => x.tf))];
        const p = sum(g.items.map(x => x.price)) / g.items.length;
        return {
          price: p, tfs, tfCount: tfs.length,
          base: sum(g.items.map(x => x.strength)) / g.items.length + (tfs.length - 1) * 10,
          touches: sum(g.items.map(x => x.touches)),
          side: p < price ? 'support' : 'resistance',
        };
      })
      .filter(g => g.tfCount >= 2 && Math.abs(g.price / price - 1) <= (opt.maxDist || 0.15));
    const top = Math.max(1, ...raw.map(g => g.base));
    return raw
      .map(g => ({ ...g, strength: Math.round(clamp(34 + 62 * Math.sqrt(g.base / top), 34, 96)) }))
      .sort((x, y) => y.strength - x.strength)
      .slice(0, 5);
  }

  /* ---------- 入场计划 ---------- */
  function plan(o) {
    const { price, an, walls: wl, funding } = o;
    const W = { d1: 3, h4: 2, h1: 1.5, m15: 1, m5: 0.5 };
    let s = 0, avail = 0;
    for (const [tf, a] of Object.entries(an || {})) if (a) { s += (a.trend || 0) * W[tf]; avail += W[tf]; }
    const trendScore = avail ? s / avail : 0;
    let fundAdj = 0;
    if (funding != null && isFinite(funding)) {
      if (funding > 0.0005) fundAdj = -0.15;
      else if (funding < -0.0005) fundAdj = 0.15;
    }
    const imb = wl ? clamp(wl.imbalance, -1, 1) : 0;
    const total = trendScore + fundAdj + imb * 0.25;
    const bias = total >= 0.22 ? '偏多' : total <= -0.22 ? '偏空' : '震荡';
    const side = bias === '偏多' ? 'long' : bias === '偏空' ? 'short' : 'neutral';

    const A = an.h1 || an.m15 || an.h4 || an.d1;
    const a1h = A ? A.atr : price * 0.01;
    const atr15 = an.m15 ? an.m15.atr : a1h / 2;
    const reasons = [];
    reasons.push(`多周期加权趋势 ${trendScore >= 0 ? '+' : ''}${trendScore.toFixed(2)}（1d/4h/1h 权重 3/2/1.5，15m/5m 权重 1/0.5）`);
    if (A) {
      if (A.supports[0]) {
        const sp = A.supports[0];
        reasons.push(`最近支撑 ${fmtNum(sp.price)}（强度 ${sp.strength}，距现价 ${(((sp.price / price) - 1) * 100).toFixed(2)}%，主动买占比 ${(sp.buyRatio * 100).toFixed(0)}%）`);
      }
      if (A.resistances[0]) {
        const rp = A.resistances[0];
        reasons.push(`最近阻力 ${fmtNum(rp.price)}（强度 ${rp.strength}，距现价 +${(((rp.price / price) - 1) * 100).toFixed(2)}%，主动卖占比 ${((1 - rp.buyRatio) * 100).toFixed(0)}%）`);
      }
      if (A.prof) reasons.push(`1h 成交密集区 POC ${fmtNum(A.prof.poc.mid)}，价值区 ${fmtNum(A.prof.vaLo)}–${fmtNum(A.prof.vaHi)}`);
      if (A.rsi != null) reasons.push(`1h RSI(14) ${A.rsi.toFixed(1)}（${A.rsi >= 70 ? '超买' : A.rsi <= 30 ? '超卖' : '中性'}）`);
    }
    if (wl) {
      const topB = wl.bids[0], topA = wl.asks[0];
      reasons.push(`盘口近 ${(wl.bandPct * 100).toFixed(0)}%：买盘 ${fmtNum(wl.bidSum)} / 卖盘 ${fmtNum(wl.askSum)} USD，失衡 ${(wl.imbalance * 100).toFixed(1)}%`);
      if (topB) reasons.push(`最大买墙 ${fmtNum(topB.price)}（${(topB.usd / 1e6).toFixed(2)}M USD，距现价 ${topB.dist.toFixed(2)}%）`);
      if (topA) reasons.push(`最大卖墙 ${fmtNum(topA.price)}（${(topA.usd / 1e6).toFixed(2)}M USD，距现价 +${topA.dist.toFixed(2)}%）`);
    }
    if (funding != null && isFinite(funding)) {
      reasons.push(`资金费率 ${(funding * 100).toFixed(4)}%（${funding > 0.0005 ? '多头拥挤，注意反向波动' : funding < -0.0005 ? '空头拥挤，注意逼空' : '中性'}）`);
    }

    const out = { bias, side, trendScore, funding: funding ?? null, reasons };
    if (side === 'neutral') {
      const sup = A && A.supports[0], res = A && A.resistances[0];
      out.entry = sup && res ? [sup.price, res.price] : null;
      out.stop = null; out.targets = []; out.rr = null;
      out.action = '观望 / 区间两端轻仓';
      out.trigger = sup && res
        ? `区间 ${fmtNum(sup.price)}–${fmtNum(res.price)}：靠近下端且 15m 收阳再试多，靠近上端且 15m 收阴再试空；放量突破区间上沿可顺势追多。`
        : '多周期方向不一致，等价格给出明确结构（突破或回踩确认）再动手。';
      out.invalid = '价格脱离成交密集区且无回踩确认时，本区间判断失效。';
      return out;
    }

    const L = side === 'long';
    const levels = A ? (L ? A.supports : A.resistances) : [];
    const lv = levels.find(x => Math.abs(x.price / price - 1) <= 0.08) || levels[0];
    const pivot = lv ? lv.price : L ? price - a1h * 0.5 : price + a1h * 0.5;
    const zoneHalf = clamp(Math.max(atr15 * 0.35, price * 0.0012), price * 0.0008, Math.max(atr15, price * 0.003));
    // 结构止损：至少留出 1.2×15m ATR 或 0.35% 的缓冲，避免止损贴进入场区导致盈亏比虚高
    const buf = Math.max(atr15 * 1.2, price * 0.0035);

    let entryLo, entryHi, stop;
    if (L) {
      entryHi = Math.min(pivot + zoneHalf, price);
      entryLo = Math.min(entryHi - zoneHalf * 2, pivot - zoneHalf);
      stop = Math.min(pivot - buf, entryLo - buf * 0.35);
    } else {
      entryLo = Math.max(pivot - zoneHalf, price);
      entryHi = Math.max(entryLo + zoneHalf * 2, pivot + zoneHalf);
      stop = Math.max(pivot + buf, entryHi + buf * 0.35);
    }
    const mid = (entryLo + entryHi) / 2;
    const risk = Math.abs(mid - stop);
    const opp = A ? (L ? A.resistances : A.supports) : [];
    const targets = [];
    for (const t of opp) {
      if (L ? t.price > entryHi + atr15 * 0.8 : t.price < entryLo - atr15 * 0.8) targets.push(t.price);
      if (targets.length >= 2) break;
    }
    if (!targets.length) targets.push(L ? mid + risk * 2 : mid - risk * 2);
    if (targets.length < 2) targets.push(L ? mid + risk * 3 : mid - risk * 3);
    const rr = risk > 0 ? Math.abs(targets[0] - mid) / risk : null;

    out.entry = [entryLo, entryHi];
    out.stop = stop;
    out.targets = targets.slice(0, 2);
    out.rr = rr;
    if (rr != null && rr < 1.2) {
      out.action = `盈亏比不足（${rr.toFixed(2)}），等更好的位置`;
      out.trigger = `${L ? '等价格回踩' : '等价格反抽'}至 ${fmtNum(pivot)} 附近并出现 15m 反向确认 K 线再进，否则不做。`;
    } else {
      out.action = L
        ? (price <= entryHi + atr15 * 0.3 ? '现价接近支撑，可分批试多' : '等回踩支撑区分批做多')
        : (price >= entryLo - atr15 * 0.3 ? '现价接近阻力，可分批试空' : '等反抽阻力区分批做空');
      out.trigger = L
        ? `入场区间 ${fmtNum(entryLo)}–${fmtNum(entryHi)}（回踩 ${fmtNum(pivot)} 支撑带）；止损 ${fmtNum(stop)}；目标 ${targets.slice(0, 2).map(fmtNum).join(' / ')}；盈亏比 ${rr ? rr.toFixed(2) : '—'}。`
        : `入场区间 ${fmtNum(entryLo)}–${fmtNum(entryHi)}（反抽 ${fmtNum(pivot)} 阻力带）；止损 ${fmtNum(stop)}；目标 ${targets.slice(0, 2).map(fmtNum).join(' / ')}；盈亏比 ${rr ? rr.toFixed(2) : '—'}。`;
    }
    out.invalid = L
      ? `15m 收盘跌破 ${fmtNum(stop)} 视为结构破坏，止损离场。`
      : `15m 收盘站上 ${fmtNum(stop)} 视为结构破坏，止损离场。`;
    return out;
  }

  const api = { profile, pivots, cluster, analyze, walls, resonance, plan, atr, rsi, ema, fmtNum };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Levels = api;
})(typeof window !== 'undefined' ? window : globalThis);
