import type { Config, Profile } from "./config.ts";
import {
  analyzeStructure,
  atr,
  dealingRange,
  fairValueGaps,
  killzone,
  latestSweep,
  liquidityTargets,
  orderBlocks,
  type Candle,
  type Dir,
  type Sweep,
  type Zone,
} from "./smc.ts";

export interface Signal {
  symbol: string;
  profile: Profile["name"];
  dir: Dir;
  entry: number;
  sl: number;
  tp: number;
  rr: number;
  poi: Zone;
  sweep: Sweep | null;
  trigger: string; // e.g. "CHoCH"
  session: string | null;
  confluence: string[];
  signalKey: string;
}

export interface Evaluation {
  signal: Signal | null;
  why: string;
}

const none = (why: string): Evaluation => ({ signal: null, why });

/**
 * Top-down model (timeframes come from the profile):
 *  HTF -> bias (last BOS/CHoCH)
 *  MTF -> liquidity sweep + unmitigated order block / FVG (point of interest)
 *  LTF -> price taps the POI, then breaks structure in the bias direction = entry
 *
 * Three things are mandatory: HTF bias, a POI tap, and an LTF structure break.
 * Everything else is a confluence point; a trade needs `cfg.minConfluence` of them.
 * All candle arrays must contain CLOSED candles only, oldest first.
 */
export function evaluate(
  symbol: string,
  profile: Profile,
  htf: Candle[],
  mtf: Candle[],
  ltf: Candle[],
  cfg: Config,
  nowMs: number,
): Evaluation {
  if (htf.length < 50 || mtf.length < 50 || ltf.length < 50) return none("not enough candles");

  const session = killzone(nowMs);
  if (profile.killzoneRequired && !session) return none("outside kill zones");

  // ---- HTF bias ----
  const hs = analyzeStructure(htf, cfg.pivotLenHTF);
  if (hs.trend === "none") return none("no HTF structure yet");
  const dir: Dir = hs.trend;
  const range = dealingRange(htf, hs);
  const price = ltf[ltf.length - 1].c;

  // ---- MTF sweep + POI ----
  const mAtr = atr(mtf);
  const lAtr = atr(ltf);
  if (mAtr <= 0 || lAtr <= 0) return none("zero ATR");

  const sweep = latestSweep(mtf, dir, cfg.pivotLenMTF, cfg.sweepLookback);
  const ms = analyzeStructure(mtf, cfg.pivotLenMTF);
  const obs = orderBlocks(mtf, ms, dir, mAtr, cfg.dispMult, cfg.poiLookback);
  const fvgs = fairValueGaps(mtf, dir, cfg.poiLookback);
  const pois: Zone[] = [...obs, ...fvgs];
  if (!pois.length) return none("no unmitigated OB/FVG on setup timeframe");

  // ---- LTF tap + structure break ----
  const n = ltf.length;
  const ls = analyzeStructure(ltf, cfg.pivotLenLTF);
  const last = ls.events[ls.events.length - 1];
  if (!last || last.dir !== dir) return none("no entry-timeframe break in bias direction");
  if (last.idx < n - cfg.entryFresh) return none("entry-timeframe break is stale");

  const sweepTime = sweep ? mtf[sweep.idx].t : 0;
  let chosen: Zone | null = null;
  let tapIdx = -1;
  for (const z of pois) {
    for (let i = Math.max(0, n - cfg.entryWindow); i < last.idx; i++) {
      if (ltf[i].t < sweepTime) continue;
      if (ltf[i].l <= z.top && ltf[i].h >= z.bottom) {
        if (tapIdx === -1 || i < tapIdx) {
          tapIdx = i;
          chosen = z;
        }
        break;
      }
    }
  }
  if (!chosen) return none("no tap of a setup-timeframe POI before the break");
  if (dir === "bull" && price <= chosen.bottom) return none("price already through the POI");
  if (dir === "bear" && price >= chosen.top) return none("price already through the POI");

  // ---- confluence ----
  const confluence: string[] = [];
  if (sweep) confluence.push("liquidity sweep");
  if (range && (dir === "bull" ? price <= range.eq : price >= range.eq)) confluence.push(dir === "bull" ? "discount" : "premium");
  if (session) confluence.push(`kill zone (${session})`);
  const bk = ltf[last.idx];
  if (Math.abs(bk.c - bk.o) >= cfg.dispMult * lAtr) confluence.push("displacement break");
  const other = (chosen.kind === "OB" ? fvgs : obs).some((z) => z.top >= chosen!.bottom && z.bottom <= chosen!.top);
  if (other) confluence.push("OB+FVG overlap");
  if (ms.trend === dir) confluence.push("setup timeframe aligned");
  if (confluence.length < cfg.minConfluence) return none(`confluence ${confluence.length}/${cfg.minConfluence} (${confluence.join(", ") || "none"})`);

  // ---- stop / target ----
  const buffer = cfg.slBufferAtr * mAtr;
  const entry = price;
  const sl =
    dir === "bull"
      ? Math.min(chosen.bottom, sweep ? sweep.extreme : Infinity) - buffer
      : Math.max(chosen.top, sweep ? sweep.extreme : -Infinity) + buffer;
  const risk = Math.abs(entry - sl);
  if (risk < cfg.minSlAtr * mAtr) return none("stop too tight");
  if (risk > cfg.maxSlAtr * mAtr) return none("stop too wide");

  const targets = [
    ...liquidityTargets(htf, dir, cfg.pivotLenHTF, entry),
    ...liquidityTargets(mtf, dir, cfg.pivotLenMTF, entry),
  ].sort((a, b) => (dir === "bull" ? a - b : b - a));
  let tp: number | null = null;
  for (const t of targets) {
    if (Math.abs(t - entry) / risk >= profile.minRR) {
      tp = t;
      break;
    }
  }
  if (tp === null) return none(`no liquidity target with RR >= ${profile.minRR}`);
  let rr = Math.abs(tp - entry) / risk;
  if (rr > profile.maxRR) {
    rr = profile.maxRR;
    tp = dir === "bull" ? entry + rr * risk : entry - rr * risk;
  }

  return {
    signal: {
      symbol,
      profile: profile.name,
      dir,
      entry,
      sl,
      tp,
      rr,
      poi: chosen,
      sweep,
      trigger: last.type,
      session,
      confluence,
      signalKey: `${symbol}:${profile.name}:${dir}:${ltf[last.idx].t}`,
    },
    why: "signal",
  };
}
