// Pure SMC / ICT analysis helpers. No I/O, so everything here is unit-testable.

export interface Candle {
  t: number; // open time, epoch seconds
  o: number;
  h: number;
  l: number;
  c: number;
}

export type Dir = "bull" | "bear";

export interface Swing {
  idx: number;
  price: number;
}

export interface BreakEvent {
  type: "BOS" | "CHoCH";
  dir: Dir;
  idx: number; // candle that closed through the level
  level: number; // the swing level that was broken
  anchorIdx: number; // opposite swing that started the leg (swing low for bull, swing high for bear)
}

export interface Structure {
  trend: Dir | "none";
  events: BreakEvent[];
}

export interface Zone {
  kind: "OB" | "FVG";
  dir: Dir;
  top: number;
  bottom: number;
  idx: number;
}

export interface Sweep {
  dir: Dir; // bull = sell-side liquidity swept (long setup), bear = buy-side swept (short setup)
  level: number;
  idx: number; // candle that took the liquidity
  extreme: number; // lowest low (bull) / highest high (bear) of the sweep
}

export interface DealingRange {
  high: number;
  low: number;
  eq: number;
}

export function atr(c: Candle[], period = 14): number {
  if (c.length < 2) return 0;
  const start = Math.max(1, c.length - period);
  let sum = 0;
  let n = 0;
  for (let i = start; i < c.length; i++) {
    const tr = Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c));
    sum += tr;
    n++;
  }
  return n ? sum / n : 0;
}

export function isPivotHigh(c: Candle[], p: number, len: number): boolean {
  if (p - len < 0 || p + len >= c.length) return false;
  for (let k = p - len; k <= p + len; k++) {
    if (k !== p && c[k].h >= c[p].h) return false;
  }
  return true;
}

export function isPivotLow(c: Candle[], p: number, len: number): boolean {
  if (p - len < 0 || p + len >= c.length) return false;
  for (let k = p - len; k <= p + len; k++) {
    if (k !== p && c[k].l <= c[p].l) return false;
  }
  return true;
}

export function swingHighs(c: Candle[], len: number): Swing[] {
  const out: Swing[] = [];
  for (let p = len; p < c.length - len; p++) if (isPivotHigh(c, p, len)) out.push({ idx: p, price: c[p].h });
  return out;
}

export function swingLows(c: Candle[], len: number): Swing[] {
  const out: Swing[] = [];
  for (let p = len; p < c.length - len; p++) if (isPivotLow(c, p, len)) out.push({ idx: p, price: c[p].l });
  return out;
}

/**
 * Walks the candles and records every close-through of the latest confirmed swing.
 * A break in the direction of the running trend is a BOS; a break against it is a CHoCH.
 */
export function analyzeStructure(c: Candle[], len: number): Structure {
  let lastHigh: (Swing & { broken: boolean }) | undefined;
  let lastLow: (Swing & { broken: boolean }) | undefined;
  let trend: Dir | "none" = "none";
  const events: BreakEvent[] = [];

  for (let i = 0; i < c.length; i++) {
    const p = i - len;
    if (p >= len) {
      if (isPivotHigh(c, p, len)) lastHigh = { idx: p, price: c[p].h, broken: false };
      if (isPivotLow(c, p, len)) lastLow = { idx: p, price: c[p].l, broken: false };
    }
    if (lastHigh && !lastHigh.broken && c[i].c > lastHigh.price) {
      lastHigh.broken = true;
      events.push({
        type: trend === "bear" ? "CHoCH" : "BOS",
        dir: "bull",
        idx: i,
        level: lastHigh.price,
        anchorIdx: lastLow ? lastLow.idx : lastHigh.idx,
      });
      trend = "bull";
    } else if (lastLow && !lastLow.broken && c[i].c < lastLow.price) {
      lastLow.broken = true;
      events.push({
        type: trend === "bull" ? "CHoCH" : "BOS",
        dir: "bear",
        idx: i,
        level: lastLow.price,
        anchorIdx: lastHigh ? lastHigh.idx : lastLow.idx,
      });
      trend = "bear";
    }
  }
  return { trend, events };
}

/** The leg created by the latest break: used for premium / discount (equilibrium = 50%). */
export function dealingRange(c: Candle[], st: Structure): DealingRange | null {
  const ev = st.events[st.events.length - 1];
  if (!ev) return null;
  // The leg runs from the previous structure break (or the start of the data) to now.
  const from = st.events.length > 1 ? st.events[st.events.length - 2].idx : 0;
  if (ev.dir === "bull") {
    // origin = lowest low up to the break, extreme = highest high since
    let low = Infinity;
    let high = -Infinity;
    for (let i = from; i < c.length; i++) {
      if (i <= ev.idx) low = Math.min(low, c[i].l);
      high = Math.max(high, c[i].h);
    }
    return { high, low, eq: (high + low) / 2 };
  }
  // bear: origin = highest high up to the break, extreme = lowest low since
  let high = -Infinity;
  let low = Infinity;
  for (let i = from; i < c.length; i++) {
    if (i <= ev.idx) high = Math.max(high, c[i].h);
    low = Math.min(low, c[i].l);
  }
  return { high, low, eq: (high + low) / 2 };
}

/** Unfilled fair value gaps (a close through the far side invalidates them). */
export function fairValueGaps(c: Candle[], dir: Dir, lookback: number): Zone[] {
  const out: Zone[] = [];
  const from = Math.max(2, c.length - lookback);
  for (let i = from; i < c.length; i++) {
    if (dir === "bull" && c[i - 2].h < c[i].l) {
      const zone: Zone = { kind: "FVG", dir, bottom: c[i - 2].h, top: c[i].l, idx: i - 1 };
      let ok = true;
      for (let k = i + 1; k < c.length; k++) if (c[k].c < zone.bottom) ok = false;
      if (ok) out.push(zone);
    }
    if (dir === "bear" && c[i - 2].l > c[i].h) {
      const zone: Zone = { kind: "FVG", dir, bottom: c[i].h, top: c[i - 2].l, idx: i - 1 };
      let ok = true;
      for (let k = i + 1; k < c.length; k++) if (c[k].c > zone.top) ok = false;
      if (ok) out.push(zone);
    }
  }
  return out;
}

/**
 * Order block = last opposite-colour candle before the displacement candle that
 * produced a structure break. Requires real displacement (body >= dispMult * ATR).
 */
export function orderBlocks(c: Candle[], st: Structure, dir: Dir, atrValue: number, dispMult: number, lookback: number): Zone[] {
  const out: Zone[] = [];
  for (const ev of st.events) {
    if (ev.dir !== dir) continue;
    if (ev.idx < c.length - lookback) continue;
    let d = -1;
    let best = 0;
    for (let i = ev.anchorIdx; i <= ev.idx; i++) {
      const body = Math.abs(c[i].c - c[i].o);
      if (body > best) {
        best = body;
        d = i;
      }
    }
    if (d < 0 || best < dispMult * atrValue) continue;
    for (let j = d - 1; j >= Math.max(ev.anchorIdx, 0); j--) {
      const opposite = dir === "bull" ? c[j].c < c[j].o : c[j].c > c[j].o;
      if (!opposite) continue;
      const zone: Zone = { kind: "OB", dir, top: c[j].h, bottom: c[j].l, idx: j };
      let ok = true;
      for (let k = ev.idx + 1; k < c.length; k++) {
        if (dir === "bull" && c[k].c < zone.bottom) ok = false;
        if (dir === "bear" && c[k].c > zone.top) ok = false;
      }
      if (ok) out.push(zone);
      break;
    }
  }
  return out;
}

/**
 * Liquidity sweep: a wick takes out a confirmed swing point and price closes back
 * inside within 2 candles. Returns the most recent one inside `lookback` candles.
 */
export function latestSweep(c: Candle[], dir: Dir, len: number, lookback: number): Sweep | null {
  const swings = dir === "bull" ? swingLows(c, len) : swingHighs(c, len);
  let best: Sweep | null = null;
  for (const s of swings) {
    for (let k = s.idx + len + 1; k < c.length; k++) {
      const took = dir === "bull" ? c[k].l < s.price : c[k].h > s.price;
      if (!took) continue;
      // first candle that trades through the level decides: sweep or true break
      let reclaimed = -1;
      for (let r = k; r <= Math.min(k + 2, c.length - 1); r++) {
        const back = dir === "bull" ? c[r].c > s.price : c[r].c < s.price;
        if (back) {
          reclaimed = r;
          break;
        }
      }
      if (reclaimed >= 0 && k >= c.length - lookback) {
        let extreme = dir === "bull" ? Infinity : -Infinity;
        for (let q = k; q <= reclaimed; q++) extreme = dir === "bull" ? Math.min(extreme, c[q].l) : Math.max(extreme, c[q].h);
        if (!best || k > best.idx) best = { dir, level: s.price, idx: k, extreme };
      }
      break;
    }
  }
  return best;
}

/** Unswept swing highs above (dir bull) / lows below (dir bear) `price`, nearest first. */
export function liquidityTargets(c: Candle[], dir: Dir, len: number, price: number): number[] {
  const swings = dir === "bull" ? swingHighs(c, len) : swingLows(c, len);
  const out: number[] = [];
  for (const s of swings) {
    let taken = false;
    for (let k = s.idx + 1; k < c.length; k++) {
      if (dir === "bull" ? c[k].h > s.price : c[k].l < s.price) {
        taken = true;
        break;
      }
    }
    if (taken) continue;
    if (dir === "bull" && s.price > price) out.push(s.price);
    if (dir === "bear" && s.price < price) out.push(s.price);
  }
  out.sort((a, b) => (dir === "bull" ? a - b : b - a));
  return out;
}

/** ICT kill zones in New York time (handles DST): London 02:00-05:00, NY AM 07:00-10:00. */
export function killzone(nowMs: number): string | null {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(nowMs));
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  const mins = h * 60 + m;
  if (mins >= 120 && mins < 300) return "London";
  if (mins >= 420 && mins < 600) return "NY-AM";
  return null;
}
