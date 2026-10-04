import { test } from "node:test";
import assert from "node:assert/strict";
import {
  analyzeStructure,
  dealingRange,
  fairValueGaps,
  killzone,
  latestSweep,
  liquidityTargets,
  orderBlocks,
  atr,
  type Candle,
} from "../src/smc.ts";
import { gateReason, sizeMultiplier } from "../src/risk.ts";

// build candles from [o,h,l,c] tuples
const mk = (rows: number[][], step = 300): Candle[] => rows.map((r, i) => ({ t: 1_700_000_000 + i * step, o: r[0], h: r[1], l: r[2], c: r[3] }));

// zig-zag up: swing low 100, swing high 110, pullback low 104, then breakout close 112
const upLeg = mk([
  [101, 102, 100.5, 101.5],
  [101.5, 103, 101, 102.5],
  [100.5, 101, 100, 100.2], // pivot low 100 (idx 2)
  [100.2, 102, 100.1, 101.8],
  [101.8, 105, 101.5, 104.5],
  [104.5, 110, 104, 109.5], // pivot high 110 (idx 5)
  [109.5, 109.8, 107, 107.5],
  [107.5, 108, 105, 105.5],
  [105.5, 106, 104, 104.5], // pullback low 104
  [104.5, 107, 104.2, 106.5],
  [106.5, 111, 106, 112], // closes above 110 -> bull break
]);

test("analyzeStructure finds a bullish BOS/CHoCH", () => {
  const st = analyzeStructure(upLeg, 2);
  assert.equal(st.trend, "bull");
  const last = st.events[st.events.length - 1];
  assert.equal(last.dir, "bull");
  assert.equal(last.level, 110);
  assert.equal(last.idx, 10);
});

test("a break against the trend is labelled CHoCH", () => {
  const down = mk([
    ...upLeg.map((k) => [k.o, k.h, k.l, k.c]),
    [112, 112.5, 107, 108],
    [108, 108.5, 104.6, 105], // pivot-ish lows
    [105, 106, 103, 103.5],
    [103.5, 104, 99, 99.5], // closes below 100 swing low
    [99.5, 100, 98, 98.5],
    [98.5, 99, 97, 97.5],
  ]);
  const st = analyzeStructure(down, 2);
  const bear = st.events.filter((e) => e.dir === "bear");
  assert.ok(bear.length >= 1);
  assert.equal(bear[0].type, "CHoCH");
});

test("dealingRange equilibrium sits mid-leg", () => {
  const st = analyzeStructure(upLeg, 2);
  const r = dealingRange(upLeg, st)!;
  assert.equal(r.low, 100);
  assert.equal(r.high, 111);
  assert.equal(r.eq, 105.5);
});

test("fairValueGaps detects bullish gap and drops filled ones", () => {
  const c = mk([
    [10, 11, 9.5, 10.5],
    [10.5, 13, 10.4, 12.8], // displacement
    [12.8, 14, 12, 13.5], // low 12 > c[0].high 11 -> gap 11..12
    [13.5, 14.5, 13, 14],
  ]);
  const gaps = fairValueGaps(c, "bull", 10);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].bottom, 11);
  assert.equal(gaps[0].top, 12);
  c.push({ t: c[3].t + 300, o: 14, h: 14, l: 10, c: 10.5 }); // closes below gap bottom
  assert.equal(fairValueGaps(c, "bull", 10).length, 0);
});

test("orderBlocks picks the last down candle before displacement", () => {
  const st = analyzeStructure(upLeg, 2);
  const obs = orderBlocks(upLeg, st, "bull", 2, 1.0, 50);
  assert.ok(obs.length >= 1);
  assert.equal(obs[0].dir, "bull");
  assert.ok(obs[0].bottom < obs[0].top);
});

test("latestSweep: wick below a swing low that closes back inside", () => {
  const c = mk([
    [105, 106, 104, 105.5],
    [105.5, 106, 103, 103.5],
    [103.5, 104, 100, 101], // pivot low 100 (idx 2)
    [101, 104, 100.5, 103.5],
    [103.5, 106, 103, 105.5],
    [105.5, 107, 105, 106.5],
    [106.5, 107, 99, 103], // sweeps 100, closes back above
    [103, 105, 102.5, 104.5],
  ]);
  const s = latestSweep(c, "bull", 2, 10)!;
  assert.ok(s);
  assert.equal(s.level, 100);
  assert.equal(s.extreme, 99);
  assert.equal(s.idx, 6);
});

test("latestSweep ignores a real break (no reclaim)", () => {
  const c = mk([
    [105, 106, 104, 105.5],
    [105.5, 106, 103, 103.5],
    [103.5, 104, 100, 101],
    [101, 104, 100.5, 103.5],
    [103.5, 106, 103, 105.5],
    [105.5, 107, 105, 106.5],
    [106.5, 107, 98, 98.5],
    [98.5, 99, 97, 97.5],
    [97.5, 98, 96, 96.5],
    [96.5, 97, 95, 95.5],
  ]);
  assert.equal(latestSweep(c, "bull", 2, 10), null);
});

test("liquidityTargets returns unswept highs above price, nearest first", () => {
  const targets = liquidityTargets(upLeg.slice(0, 10), "bull", 2, 106);
  assert.deepEqual(targets, [110]);
});

test("atr is positive on real ranges", () => {
  assert.ok(atr(upLeg) > 0);
});

test("killzone follows New York time incl. DST", () => {
  // 2026-10-05 12:00 UTC = 08:00 EDT -> NY AM
  assert.equal(killzone(Date.UTC(2026, 9, 5, 12, 0)), "NY-AM");
  // 2026-10-05 07:00 UTC = 03:00 EDT -> London
  assert.equal(killzone(Date.UTC(2026, 9, 5, 7, 0)), "London");
  // 2026-12-07 12:00 UTC = 07:00 EST -> NY AM (DST ended)
  assert.equal(killzone(Date.UTC(2026, 11, 7, 12, 0)), "NY-AM");
  // 2026-10-05 17:00 UTC = 13:00 EDT -> outside
  assert.equal(killzone(Date.UTC(2026, 9, 5, 17, 0)), null);
});

const BASE = {
  balance: 1000,
  riskPct: 1,
  entry: 1.1,
  sl: 1.098,
  rr: 2,
  multipliers: [30, 50, 100, 200, 300, 500],
  maxStakePct: 25,
  maxLeverage: 20,
  maxTotalRiskPct: 2,
  openRisk: 0,
  openNotional: 0,
  openStake: 0,
};

test("sizeMultiplier risks exactly riskPct at the stop", () => {
  const entry = 1.1;
  const sl = 1.098; // ~0.18% away
  const s = sizeMultiplier({ ...BASE, entry, sl, rr: 3 })!;
  assert.ok(s);
  assert.equal(s.stopLoss, 10);
  assert.equal(s.takeProfit, 30);
  assert.ok(s.stake > s.stopLoss);
  const lossAtSl = s.stake * s.multiplier * (Math.abs(entry - sl) / entry);
  assert.ok(Math.abs(lossAtSl - 10) < 0.1, `loss at SL was ${lossAtSl}`);
});

test("sizeMultiplier refuses when the stop is so tight no multiplier fits", () => {
  const s = sizeMultiplier({ ...BASE, entry: 1.1, sl: 1.0999, rr: 2, multipliers: [30, 50], maxLeverage: 1000 });
  assert.equal(s, null);
});

test("gateReason enforces the daily rules", () => {
  const cfg = { maxTradesPerDay: 3, maxConsecLosses: 3, dailyLossPct: 3 };
  const base = { day: "2026-10-05", startBalance: 1000, tradesToday: 0, consecLosses: 0 };
  assert.equal(gateReason(base, 1000, cfg), null);
  assert.ok(gateReason({ ...base, tradesToday: 3 }, 1000, cfg));
  assert.ok(gateReason({ ...base, consecLosses: 3 }, 1000, cfg));
  assert.ok(gateReason(base, 969, cfg));
  assert.equal(gateReason(base, 975, cfg), null);
});

test("leverage cap shrinks risk instead of over-levering a tight stop", () => {
  // 0.1% stop would need 10x balance notional for 1% risk; cap at 5x -> risk halves
  const s = sizeMultiplier({ ...BASE, entry: 1.1, sl: 1.0989, maxLeverage: 5 })!;
  assert.ok(s);
  assert.ok(s.leverage <= 5.01, `leverage ${s.leverage}`);
  assert.ok(s.riskAmount < 10);
});

test("open exposure reduces room for a new trade", () => {
  const s = sizeMultiplier({ ...BASE, openRisk: 15, openNotional: 0 })!; // 2% cap = 20, 15 used -> 5 left
  assert.ok(s);
  assert.equal(s.riskAmount, 5);
  assert.equal(sizeMultiplier({ ...BASE, openRisk: 20 }), null);
  assert.equal(sizeMultiplier({ ...BASE, openNotional: 20000 }), null);
});

test("sizeFactor can only shrink a trade", () => {
  const full = sizeMultiplier({ ...BASE })!;
  const half = sizeMultiplier({ ...BASE, sizeFactor: 0.5 })!;
  const over = sizeMultiplier({ ...BASE, sizeFactor: 5 })!;
  assert.ok(half.riskAmount < full.riskAmount);
  assert.equal(over.riskAmount, full.riskAmount);
});
