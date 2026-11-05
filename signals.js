/* Shared signal / indicator logic. Works in browser (window.Signals) and Node (require). */
(function (root) {
  // Normalized kline: {t, o, h, l, c, qv, closed} oldest -> newest
  function normBinance(raw) {
    const now = Date.now();
    return raw.map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], qv: +k[7], closed: k[6] < now }));
  }
  function normOkx(raw) {
    // OKX: newest first; [ts,o,h,l,c,vol,volCcy,volCcyQuote,confirm]
    return raw.slice().reverse().map(k => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], qv: +k[7], closed: k[8] === '1' }));
  }
  const closed = ks => ks.filter(k => k.closed);
  const bull = k => k.c > k.o, bear = k => k.c < k.o;

  // Return of the current (live) candle vs its open, in %
  function liveReturn(ks) { const k = ks[ks.length - 1]; return k ? (k.c / k.o - 1) * 100 : null; }
  // Consecutive closed candles of same direction ending at most recent closed
  function streak(ks) {
    const c = closed(ks); let n = 0, dir = 0;
    for (let i = c.length - 1; i >= 0; i--) {
      const d = bull(c[i]) ? 1 : bear(c[i]) ? -1 : 0;
      if (d === 0) break; if (dir === 0) dir = d; if (d !== dir) break; n++;
    }
    return { dir, n };
  }
  function rsi(ks, p = 14) {
    const c = ks.map(k => k.c); if (c.length < p + 1) return null;
    let g = 0, l = 0;
    for (let i = 1; i <= p; i++) { const d = c[i] - c[i - 1]; d > 0 ? g += d : l -= d; }
    g /= p; l /= p;
    for (let i = p + 1; i < c.length; i++) { const d = c[i] - c[i - 1]; g = (g * (p - 1) + Math.max(d, 0)) / p; l = (l * (p - 1) + Math.max(-d, 0)) / p; }
    return l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  // last closed 1h quote volume vs avg of 24 closed before it
  function volMultiple(ks1h) {
    const c = closed(ks1h); if (c.length < 25) return null;
    const last = c[c.length - 1].qv, prev = c.slice(-25, -1);
    const avg = prev.reduce((s, k) => s + k.qv, 0) / prev.length;
    return avg ? last / avg : null;
  }
  // Last n closed all same direction; returns {ok, ret%} ret = from open of first to close of last
  function lastN(ks, n, wantBull) {
    const c = closed(ks).slice(-n); if (c.length < n) return { ok: false, ret: null };
    const ok = c.every(wantBull ? bull : bear);
    return { ok, ret: (c[c.length - 1].c / c[0].o - 1) * 100 };
  }
  /**
   * Trend-pullback signal. side 'long': 1h/4h/1d last N closed bullish & ret>0, last K closed 15m bearish.
   * side 'short' mirrors. k = {m15,h1,h4,d1}
   */
  function evaluate(k, opt = {}) {
    const N = opt.N || 2, K = opt.K || 3, side = opt.side || 'long';
    const L = side === 'long';
    const h1 = lastN(k.h1, N, L), h4 = lastN(k.h4, N, L), d1 = lastN(k.d1, N, L);
    const m15 = lastN(k.m15, K, !L);
    const st = streak(k.m15);
    const r15 = rsi(closed(k.m15));
    const higherOk = h1.ok && h4.ok && d1.ok && (L ? h1.ret > 0 && h4.ret > 0 && d1.ret > 0 : h1.ret < 0 && h4.ret < 0 && d1.ret < 0);
    const match = higherOk && m15.ok;
    // pullback depth: from high (long) / low (short) of the K candles to current price
    const c15 = closed(k.m15).slice(-K);
    const price = k.m15[k.m15.length - 1].c;
    let pull = null;
    if (c15.length) pull = L ? (price / Math.max(...c15.map(x => x.h)) - 1) * 100 : (price / Math.min(...c15.map(x => x.l)) - 1) * 100;
    let score = null;
    if (match) {
      const sgn = L ? 1 : -1;
      const trend = sgn * (h1.ret + h4.ret + d1.ret);
      const depth = Math.min(Math.abs(pull || 0), 5);
      const rsiBonus = r15 == null ? 0 : L ? Math.max(0, 45 - r15) * 0.3 : Math.max(0, r15 - 55) * 0.3;
      const vm = volMultiple(k.h1) || 1;
      score = +(trend * 1 + depth * 1.5 + rsiBonus + Math.min(vm, 3)).toFixed(2);
    }
    return { match, score, h1, h4, d1, m15, streak15: st, pullback: pull, rsi15: r15, price };
  }
  function metrics(k) {
    return {
      ret: { m15: liveReturn(k.m15), h1: liveReturn(k.h1), h4: liveReturn(k.h4), d1: liveReturn(k.d1) },
      streak15: streak(k.m15), rsi15: rsi(closed(k.m15)), rsi1h: rsi(closed(k.h1)), volMult: volMultiple(k.h1),
    };
  }
  const api = { normBinance, normOkx, streak, rsi, volMultiple, lastN, evaluate, metrics, liveReturn };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Signals = api;
})(typeof window !== 'undefined' ? window : globalThis);
