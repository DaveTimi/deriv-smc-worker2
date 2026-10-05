// Backtest: replays the bot's REAL strategy (src/strategy.ts, src/risk.ts) over historical Deriv candles.
//
//   node --experimental-strip-types scripts/backtest.ts --days 30
//
// Options (flag or env var):  --days / BT_DAYS (30)   --balance / BT_BALANCE (10000)
//   --symbols / SYMBOLS   --profiles / PROFILES   --cost / BT_COST_PCT (0)   --out (backtest-out)
//   --cache <dir>  reuse/save downloaded candles in <dir> (handy for re-runs)
// Every other bot setting (RISK_PCT, MIN_CONFLUENCE, ...) is read from wrangler.jsonc "vars",
// and can be overridden with an env var of the same name.
//
// Simplifications (the report repeats these): the AI second-opinion is NOT simulated; no spread,
// slippage or commission unless --cost is given; fills happen at the signal's entry price;
// if stop and target are both touched inside one 1-minute candle the stop is assumed to hit first.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { loadConfig, type Config, type Env } from "../src/config.ts";
import { gateReason, sizeMultiplier } from "../src/risk.ts";
import { killzone, type Candle, type Dir } from "../src/smc.ts";
import { evaluate } from "../src/strategy.ts";

// ------------------------------------------------------------------ candles

/** Build higher-timeframe candles from 1-minute candles (buckets aligned to the epoch, like Deriv). */
export function aggregate(m1: Candle[], gran: number): Candle[] {
  if (gran === 60) return m1;
  const out: Candle[] = [];
  let cur: Candle | null = null;
  for (const k of m1) {
    const b = Math.floor(k.t / gran) * gran;
    if (!cur || cur.t !== b) {
      if (cur) out.push(cur);
      cur = { t: b, o: k.o, h: k.h, l: k.l, c: k.c };
    } else {
      if (k.h > cur.h) cur.h = k.h;
      if (k.l < cur.l) cur.l = k.l;
      cur.c = k.c;
    }
  }
  if (cur) out.push(cur);
  return out;
}

// ------------------------------------------------------------------ simulation

export interface Trade {
  symbol: string;
  profile: string;
  dir: Dir;
  entryT: number;
  exitT: number; // Infinity while unresolved
  outcome: "tp" | "sl" | "open";
  entry: number;
  sl: number;
  tp: number;
  rr: number;
  risk: number;
  stake: number;
  notional: number;
  pnl: number;
  r: number;
  session: string;
  trigger: string;
  poi: string;
  confluence: string;
}

/** Walk 1-minute candles from `fromT`; the stop wins if both levels are touched in the same candle. */
export function simulateExit(m1: Candle[], fromT: number, dir: Dir, sl: number, tp: number): { exitT: number; outcome: "tp" | "sl" } | null {
  let lo = 0;
  let hi = m1.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (m1[mid].t < fromT) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo; i < m1.length; i++) {
    const c = m1[i];
    const slHit = dir === "bull" ? c.l <= sl : c.h >= sl;
    const tpHit = dir === "bull" ? c.h >= tp : c.l <= tp;
    if (slHit) return { exitT: c.t + 60, outcome: "sl" };
    if (tpHit) return { exitT: c.t + 60, outcome: "tp" };
  }
  return null;
}

export interface BtResult {
  trades: Trade[];
  stillOpen: Trade[];
  startBalance: number;
  finalBalance: number;
  maxDrawdownPct: number;
  evals: number;
  noRoom: number;
  staleSkips: number;
  gateSkips: Record<string, number>;
  reasons: Record<string, number>;
  startT: number;
  endT: number;
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const dayOf = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);

/**
 * Mirrors the live loop (src/bot.ts + src/index.ts): cron slot N runs at UTC minutes where minute % 5 == N and
 * scans symbols[N]; swing only evaluates when minute % 15 < 5; daily counters reset each UTC day.
 */
export function runBacktest(cfg: Config, m1BySymbol: Record<string, Candle[]>, o: { startT: number; endT: number; balance: number; costPct: number }): BtResult {
  const aggCache = new Map<string, Candle[]>();
  const tf = (sym: string, g: number) => {
    const k = `${sym}:${g}`;
    let v = aggCache.get(k);
    if (!v) {
      v = aggregate(m1BySymbol[sym] ?? [], g);
      aggCache.set(k, v);
    }
    return v;
  };
  const ptr = new Map<string, number>();
  const closedCount = (sym: string, g: number, T: number) => {
    const arr = tf(sym, g);
    const k = `${sym}:${g}`;
    let p = ptr.get(k) ?? 0;
    while (p < arr.length && arr[p].t + g <= T) p++;
    ptr.set(k, p);
    return p;
  };
  const memo = new Map<string, { key: string; ev: ReturnType<typeof evaluate> }>();

  let balance = o.balance;
  const st = { day: "", startBalance: 0, tradesToday: 0, consecLosses: 0, open: [] as Trade[], handled: [] as string[] };
  const closed: Trade[] = [];
  let peak = balance;
  let maxDD = 0;
  const res: BtResult = {
    trades: closed,
    stillOpen: [],
    startBalance: o.balance,
    finalBalance: balance,
    maxDrawdownPct: 0,
    evals: 0,
    noRoom: 0,
    staleSkips: 0,
    gateSkips: {},
    reasons: {},
    startT: o.startT,
    endT: o.endT,
  };

  for (let T = o.startT; T < o.endT; T += 60) {
    const minute = Math.floor(T / 60) % 60;
    const slot = minute % 5;
    if (slot > 2 || slot >= cfg.symbols.length) continue; // only 3 crons exist
    const nowMs = T * 1000 + 5000; // cron fires a few seconds after the minute

    // new UTC day: reset the daily counters (open positions and handled keys carry over)
    const day = dayOf(T);
    if (day !== st.day) {
      st.day = day;
      st.startBalance = 0;
      st.tradesToday = 0;
      st.consecLosses = 0;
    }

    // Deriv's balance already includes closed trades; the bot then settles its counters
    const due = st.open.filter((p) => p.exitT <= T).sort((a, b) => a.exitT - b.exitT);
    if (!st.startBalance) st.startBalance = balance + sum(due.map((p) => p.pnl));
    for (const p of due) {
      balance += p.pnl;
      st.consecLosses = p.pnl < 0 ? st.consecLosses + 1 : 0;
      st.open = st.open.filter((x) => x !== p);
      closed.push(p);
      peak = Math.max(peak, balance);
      maxDD = Math.max(maxDD, ((peak - balance) / peak) * 100);
    }

    const blocked = gateReason(st, balance, cfg);
    if (blocked) {
      const k = blocked.replace(/\d+(\.\d+)?/g, "N");
      res.gateSkips[k] = (res.gateSkips[k] ?? 0) + 1;
      continue;
    }
    const symbol = cfg.symbols[slot];
    if (st.open.length >= cfg.maxOpen || st.open.some((p) => p.symbol === symbol)) continue;

    for (const profile of cfg.profiles) {
      if (minute % profile.evalEveryMin >= 5) continue;
      const pH = closedCount(symbol, profile.htf, T);
      const pM = closedCount(symbol, profile.mtf, T);
      const pL = closedCount(symbol, profile.ltf, T);
      const ltfAll = tf(symbol, profile.ltf);
      const lastLtf = pL > 0 ? ltfAll[pL - 1] : undefined;
      if (!lastLtf || nowMs - (lastLtf.t + profile.ltf) * 1000 > Math.max(3 * profile.ltf, 300) * 1000) {
        res.staleSkips++;
        continue;
      }
      const slice = (g: number, p: number) => tf(symbol, g).slice(Math.max(0, p - cfg.candleCount), p);

      // evaluate() is pure, so identical inputs can reuse the previous answer
      const mk = `${symbol}:${profile.name}`;
      const key = `${pH}|${pM}|${pL}|${killzone(nowMs)}`;
      let ev = memo.get(mk);
      if (!ev || ev.key !== key) {
        ev = { key, ev: evaluate(symbol, profile, slice(profile.htf, pH), slice(profile.mtf, pM), slice(profile.ltf, pL), cfg, nowMs) };
        memo.set(mk, ev);
      }
      res.evals++;
      const s = ev.ev.signal;
      if (!s) {
        const why = ev.ev.why.startsWith("confluence") ? "confluence below minimum" : ev.ev.why;
        res.reasons[why] = (res.reasons[why] ?? 0) + 1;
        continue;
      }
      if (st.handled.includes(s.signalKey)) continue;

      const size = sizeMultiplier({
        balance,
        riskPct: cfg.riskPct * profile.riskScale,
        entry: s.entry,
        sl: s.sl,
        rr: s.rr,
        multipliers: cfg.fallbackMultipliers,
        maxStakePct: cfg.maxStakePct,
        maxLeverage: cfg.maxLeverage,
        maxTotalRiskPct: cfg.maxTotalRiskPct,
        openRisk: sum(st.open.map((p) => p.risk)),
        openNotional: sum(st.open.map((p) => p.notional)),
        openStake: sum(st.open.map((p) => p.stake)),
      });
      if (!size) {
        res.noRoom++;
        continue;
      }
      st.handled.push(s.signalKey);
      st.handled = st.handled.slice(-50);

      const fate = simulateExit(m1BySymbol[symbol], T, s.dir, s.sl, s.tp);
      const cost = (o.costPct / 100) * size.notional;
      const pnl = fate ? (fate.outcome === "tp" ? size.takeProfit : -size.stopLoss) - cost : -cost;
      const t: Trade = {
        symbol,
        profile: profile.name,
        dir: s.dir,
        entryT: T,
        exitT: fate ? fate.exitT : Infinity,
        outcome: fate ? fate.outcome : "open",
        entry: s.entry,
        sl: s.sl,
        tp: s.tp,
        rr: s.rr,
        risk: size.riskAmount,
        stake: size.stake,
        notional: size.notional,
        pnl,
        r: size.riskAmount > 0 ? pnl / size.riskAmount : 0,
        session: s.session ?? "none",
        trigger: s.trigger,
        poi: s.poi.kind,
        confluence: s.confluence.join("; "),
      };
      st.open.push(t);
      st.tradesToday += 1;
      break; // one position per symbol
    }
  }

  // anything that resolves after the last tick still counts if its exit is inside the data
  for (const p of st.open.filter((x) => x.exitT !== Infinity).sort((a, b) => a.exitT - b.exitT)) {
    balance += p.pnl;
    closed.push(p);
    peak = Math.max(peak, balance);
    maxDD = Math.max(maxDD, ((peak - balance) / peak) * 100);
  }
  res.stillOpen = st.open.filter((x) => x.exitT === Infinity);
  res.finalBalance = balance;
  res.maxDrawdownPct = maxDD;
  return res;
}

// ------------------------------------------------------------------ statistics

export interface Stats {
  n: number;
  wins: number;
  winRate: number;
  expectancyR: number;
  profitFactor: number;
  netPnl: number;
  maxLossStreak: number;
}

export function stats(trades: Trade[]): Stats {
  const wins = trades.filter((t) => t.pnl > 0);
  const gw = sum(wins.map((t) => t.pnl));
  const gl = Math.abs(sum(trades.filter((t) => t.pnl <= 0).map((t) => t.pnl)));
  let streak = 0;
  let maxStreak = 0;
  for (const t of [...trades].sort((a, b) => a.exitT - b.exitT)) {
    streak = t.pnl <= 0 ? streak + 1 : 0;
    maxStreak = Math.max(maxStreak, streak);
  }
  return {
    n: trades.length,
    wins: wins.length,
    winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
    expectancyR: trades.length ? sum(trades.map((t) => t.r)) / trades.length : 0,
    profitFactor: gl > 0 ? gw / gl : gw > 0 ? Infinity : 0,
    netPnl: sum(trades.map((t) => t.pnl)),
    maxLossStreak: maxStreak,
  };
}

const f2 = (n: number) => (Number.isFinite(n) ? n.toFixed(2) : "inf");
const iso = (t: number) => new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ");

function group(trades: Trade[], key: (t: Trade) => string): string {
  const keys = [...new Set(trades.map(key))].sort();
  const rows = keys.map((k) => {
    const s = stats(trades.filter((t) => key(t) === k));
    return `| ${k} | ${s.n} | ${f2(s.winRate)}% | ${f2(s.expectancyR)} | ${f2(s.profitFactor)} | ${f2(s.netPnl)} |`;
  });
  return ["| | Trades | Win rate | Avg R | Profit factor | Net P/L |", "|---|---|---|---|---|---|", ...rows].join("\n");
}

export function report(r: BtResult, cfg: Config, o: { days: number; costPct: number; data?: Record<string, Candle[]> }): string {
  const s = stats(r.trades);
  const ret = ((r.finalBalance - r.startBalance) / r.startBalance) * 100;
  const L: string[] = [];
  L.push(`# Backtest: ${iso(r.startT)} to ${iso(r.endT)} UTC (${o.days} days)`);
  L.push(`Symbols: ${cfg.symbols.join(", ")} | Profiles: ${cfg.profiles.map((p) => p.name).join(", ")} | Risk ${cfg.riskPct}% | Min confluence ${cfg.minConfluence}`);
  L.push("");
  if (o.data) {
    L.push("## Data downloaded");
    for (const [sym, cs] of Object.entries(o.data)) L.push(`- ${sym}: ${cs.length} one-minute candles, ${cs.length ? iso(cs[0].t) + " to " + iso(cs[cs.length - 1].t) : "none"}`);
    L.push("");
  }
  L.push("## Result");
  L.push(`- Trades: **${s.n}** (${s.wins} wins) | Win rate: **${f2(s.winRate)}%**`);
  L.push(`- Average result per trade: **${f2(s.expectancyR)} R** (positive = profitable on average)`);
  L.push(`- Profit factor: **${f2(s.profitFactor)}** (above 1 = wins outweigh losses)`);
  L.push(`- Balance: ${f2(r.startBalance)} -> **${f2(r.finalBalance)}** (${ret >= 0 ? "+" : ""}${f2(ret)}%) | Max drawdown: **${f2(r.maxDrawdownPct)}%**`);
  L.push(`- Longest losing streak: ${s.maxLossStreak} | Still open at the end: ${r.stillOpen.length}`);
  if (s.n < 30) L.push(`- **Only ${s.n} trades: far too few to trust any of these numbers. Use more days.**`);
  L.push("");
  L.push("## By profile\n" + group(r.trades, (t) => t.profile));
  L.push("");
  L.push("## By symbol\n" + group(r.trades, (t) => t.symbol));
  L.push("");
  L.push("## By session\n" + group(r.trades, (t) => t.session));
  L.push("");
  const top = Object.entries(r.reasons).sort((a, b) => b[1] - a[1]).slice(0, 6);
  L.push("## Why other checks produced no trade");
  L.push(`Evaluations: ${r.evals} | skipped as stale/closed market: ${r.staleSkips} | setups with no room under risk limits: ${r.noRoom}`);
  for (const [k, v] of top) L.push(`- ${k}: ${v}`);
  for (const [k, v] of Object.entries(r.gateSkips)) L.push(`- risk gate "${k}": ${v} checks`);
  L.push("");
  L.push("## What this does NOT include");
  L.push("- The AI second opinion (the live bot may skip or shrink some of these trades).");
  L.push(o.costPct > 0 ? `- Spread/slippage. A cost of ${o.costPct}% of notional per trade IS included.` : "- Spread, slippage and Deriv's commission (use --cost to add a per-trade cost). Real results will be worse.");
  L.push("- Fills assume the signal's entry price. If stop and target are hit in the same minute, the stop is assumed first.");
  L.push("- Multiplier choices use the fallback list; Deriv's real limits per symbol may differ.");
  L.push("- A backtest is a look backwards. A good result does not guarantee future profit.");
  return L.join("\n");
}

export function tradesCsv(trades: Trade[]): string {
  const head = "symbol,profile,dir,entry_time,exit_time,outcome,entry,sl,tp,rr,risk,pnl,r,session,trigger,poi,confluence";
  const rows = trades.map((t) =>
    [t.symbol, t.profile, t.dir, iso(t.entryT), t.exitT === Infinity ? "" : iso(t.exitT), t.outcome, t.entry, t.sl, t.tp, f2(t.rr), f2(t.risk), f2(t.pnl), f2(t.r), t.session, t.trigger, t.poi, `"${t.confluence}"`].join(","),
  );
  return [head, ...rows].join("\n");
}

// ------------------------------------------------------------------ Deriv history download

class Ws {
  private ws: WebSocket;
  private next = 1;
  private pending = new Map<number, { ok: (v: any) => void; bad: (e: Error) => void }>();
  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (ev: MessageEvent) => {
      let m: any;
      try {
        m = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      const p = this.pending.get(m.req_id);
      if (!p) return;
      this.pending.delete(m.req_id);
      if (m.error) p.bad(new Error(`${m.error.code ?? "error"}: ${m.error.message ?? "unknown"}`));
      else p.ok(m);
    });
    const fail = () => {
      for (const [, p] of this.pending) p.bad(new Error("websocket closed"));
      this.pending.clear();
    };
    ws.addEventListener("close", fail);
    ws.addEventListener("error", fail);
  }
  static open(url: string): Promise<Ws> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => reject(new Error("websocket connect timeout")), 20000);
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve(new Ws(ws));
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("websocket connect error"));
      });
    });
  }
  send(payload: Record<string, unknown>, timeoutMs = 30000): Promise<any> {
    const id = this.next++;
    return new Promise((ok, bad) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        bad(new Error("timeout"));
      }, timeoutMs);
      this.pending.set(id, {
        ok: (v) => (clearTimeout(timer), ok(v)),
        bad: (e) => (clearTimeout(timer), bad(e)),
      });
      this.ws.send(JSON.stringify({ ...payload, req_id: id }));
    });
  }
  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isPlaceholder = (v?: string) => !v || v.startsWith("REPLACE");

async function connect(env: Record<string, string | undefined>): Promise<Ws> {
  const errors: string[] = [];
  const token = env.DERIV_TOKEN;
  if (token && !isPlaceholder(env.DERIV_ACCOUNT_ID) && !isPlaceholder(env.DERIV_APP_ID)) {
    try {
      const res = await fetch(`https://api.derivws.com/trading/v1/options/accounts/${env.DERIV_ACCOUNT_ID}/otp`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Deriv-App-ID": env.DERIV_APP_ID! },
      });
      if (!res.ok) throw new Error(`OTP request failed: HTTP ${res.status}`);
      const url = ((await res.json()) as any)?.data?.url;
      if (!url) throw new Error("OTP response had no url");
      return await Ws.open(url);
    } catch (e) {
      errors.push(`new API: ${(e as Error).message}`);
    }
  }
  try {
    // public candle history does not need a token; the legacy API wants a numeric app id (1089 is Deriv's test id)
    const appId = /^\d+$/.test(env.DERIV_APP_ID ?? "") ? env.DERIV_APP_ID : "1089";
    return await Ws.open(`wss://ws.derivws.com/websockets/v3?app_id=${appId}`);
  } catch (e) {
    errors.push(`legacy API: ${(e as Error).message}`);
  }
  throw new Error(`Could not connect to Deriv (${errors.join("; ")}). Add a DERIV_TOKEN secret to the repo and try again.`);
}

async function request(ws: Sender, payload: Record<string, unknown>): Promise<any> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await ws.send(payload);
    } catch (e) {
      const msg = (e as Error).message;
      if (attempt >= 4 || !/rate|limit|429|timeout/i.test(msg)) throw e;
      await sleep(2000 * attempt);
    }
  }
}

interface Sender {
  send(payload: Record<string, unknown>): Promise<any>;
}

const toCandles = (r: any): Candle[] => (r?.candles ?? []).map((k: any) => ({ t: Number(k.epoch), o: +k.open, h: +k.high, l: +k.low, c: +k.close }));

/**
 * Download 1-minute candles for [startEpoch, now], 5000 per request. Pages forward from `startEpoch` first;
 * if that leaves a big gap (the feed ignored `start`), it also pages backward from the newest candle.
 */
export async function fetchM1(ws: Sender, symbol: string, startEpoch: number, log: (m: string) => void = console.log): Promise<Candle[]> {
  const all = new Map<number, Candle>();
  const span = () => {
    const ts = [...all.keys()];
    return ts.length ? Math.max(...ts) - Math.min(...ts) : 0;
  };
  const wantSpan = Math.floor(Date.now() / 1000) - startEpoch;

  // pass 1: forward from the start
  let cursor = startEpoch;
  for (let page = 1; page <= 300; page++) {
    const cs = toCandles(await request(ws, { ticks_history: symbol, style: "candles", granularity: 60, start: cursor, end: "latest", count: 5000 }));
    if (!cs.length) {
      log(`${symbol} forward page ${page}: empty`);
      break;
    }
    let added = 0;
    for (const c of cs) if (!all.has(c.t)) (all.set(c.t, c), added++);
    log(`${symbol} forward page ${page}: ${cs.length} candles (${iso(cs[0].t)} to ${iso(cs[cs.length - 1].t)}), ${added} new`);
    const last = cs[cs.length - 1].t;
    if (!added || last < cursor || cs.length < 5000) break;
    cursor = last + 60;
    await sleep(300);
  }

  // pass 2: backward from the newest candle, only if pass 1 left a big gap
  if (span() < wantSpan * 0.8) {
    log(`${symbol}: forward paging covered only ${(span() / 86400).toFixed(1)} days, trying backward paging`);
    // continue from just before the oldest candle already held (or from the newest if none yet)
    let end: number | "latest" = all.size ? Math.min(...all.keys()) - 1 : "latest";
    for (let page = 1; page <= 300; page++) {
      const cs = toCandles(await request(ws, { ticks_history: symbol, style: "candles", granularity: 60, end, count: 5000 }));
      if (!cs.length) {
        log(`${symbol} backward page ${page}: empty`);
        break;
      }
      let added = 0;
      for (const c of cs) if (!all.has(c.t)) (all.set(c.t, c), added++);
      log(`${symbol} backward page ${page}: ${cs.length} candles (${iso(cs[0].t)} to ${iso(cs[cs.length - 1].t)}), ${added} new`);
      const first = cs[0].t;
      if (!added || first <= startEpoch) break;
      end = first - 1;
      await sleep(300);
    }
  }
  return [...all.values()].filter((c) => c.t >= startEpoch).sort((a, b) => a.t - b.t);
}

// ------------------------------------------------------------------ config + CLI

function stripJsonc(src: string): string {
  let out = "";
  let i = 0;
  let inStr = false;
  while (i < src.length) {
    const ch = src[i];
    const nx = src[i + 1];
    if (inStr) {
      out += ch;
      if (ch === "\\") {
        out += nx ?? "";
        i += 2;
        continue;
      }
      if (ch === '"') inStr = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
      i++;
    } else if (ch === "/" && nx === "/") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (ch === "/" && nx === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
    } else {
      out += ch;
      i++;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

const OVERRIDABLE = [
  "SYMBOLS", "PROFILES", "RISK_PCT", "MAX_TRADES_PER_DAY", "MAX_CONSEC_LOSSES", "DAILY_LOSS_PCT", "MAX_OPEN",
  "MAX_TOTAL_RISK_PCT", "MAX_LEVERAGE", "MAX_STAKE_PCT", "MIN_CONFLUENCE", "FALLBACK_MULTIPLIERS", "DERIV_APP_ID", "DERIV_ACCOUNT_ID",
];

function buildEnv(args: Record<string, string>): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  if (existsSync("wrangler.jsonc")) {
    const vars = JSON.parse(stripJsonc(readFileSync("wrangler.jsonc", "utf8"))).vars ?? {};
    for (const [k, v] of Object.entries(vars)) env[k] = String(v);
  }
  for (const k of OVERRIDABLE) if (process.env[k]) env[k] = process.env[k];
  if (args.symbols) env.SYMBOLS = args.symbols;
  if (args.profiles) env.PROFILES = args.profiles;
  env.DERIV_TOKEN = process.env.DERIV_TOKEN;
  return env;
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const days = Number(args.days || process.env.BT_DAYS || 30);
  const balance = Number(args.balance || process.env.BT_BALANCE || 10000);
  const costPct = Number(args.cost || process.env.BT_COST_PCT || 0);
  const outDir = args.out || "backtest-out";
  const cacheDir = args.cache;
  if (!(days > 0) || !(balance > 0)) throw new Error("--days and --balance must be positive numbers");

  const env = buildEnv(args);
  const cfg = loadConfig(env as unknown as Env);
  if (!cfg.symbols.length || !cfg.profiles.length) throw new Error("No symbols or profiles to test");

  // warm-up so every timeframe has ~candleCount candles when the test window starts (x1.4 for weekends)
  const maxHtf = Math.max(...cfg.profiles.map((p) => p.htf));
  const warmDays = Math.ceil(((cfg.candleCount * maxHtf) / 86400) * 1.4) + 2;
  const fetchStart = Math.floor(Date.now() / 1000) - (days + warmDays) * 86400;

  const data: Record<string, Candle[]> = {};
  let ws: Ws | null = null;
  try {
    for (const sym of cfg.symbols) {
      const file = cacheDir ? `${cacheDir}/${sym}.json` : "";
      if (file && existsSync(file)) {
        data[sym] = JSON.parse(readFileSync(file, "utf8"));
        console.log(`${sym}: ${data[sym].length} candles from cache`);
        continue;
      }
      ws ??= await connect(env);
      console.log(`${sym}: downloading history...`);
      data[sym] = await fetchM1(ws, sym, fetchStart);
      console.log(`${sym}: ${data[sym].length} one-minute candles`);
      if (file) {
        mkdirSync(cacheDir!, { recursive: true });
        writeFileSync(file, JSON.stringify(data[sym]));
      }
    }
  } finally {
    ws?.close();
  }

  for (const sym of cfg.symbols) {
    const cs = data[sym] ?? [];
    const gotDays = cs.length ? (cs[cs.length - 1].t - cs[0].t) / 86400 : 0;
    if (gotDays < days * 0.7) {
      throw new Error(`${sym}: Deriv only returned ${gotDays.toFixed(1)} days of history (${cs.length} candles), but ${days} days were requested. Check the "forward page" lines above in the log.`);
    }
  }
  const lasts = cfg.symbols.map((s) => data[s]?.[data[s].length - 1]?.t ?? 0);
  const endT = Math.max(...lasts) + 60;
  if (endT <= 60) throw new Error("No candle data came back from Deriv");
  const startT = Math.ceil((endT - days * 86400) / 60) * 60;

  console.log(`Running ${cfg.symbols.length} symbol(s) x ${cfg.profiles.length} profile(s)...`);
  const res = runBacktest(cfg, data, { startT, endT, balance, costPct });
  const md = report(res, cfg, { days, costPct, data });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(`${outDir}/report.md`, md);
  writeFileSync(`${outDir}/trades.csv`, tradesCsv(res.trades));
  writeFileSync(`${outDir}/summary.json`, JSON.stringify({ ...stats(res.trades), startBalance: res.startBalance, finalBalance: res.finalBalance, maxDrawdownPct: res.maxDrawdownPct }, null, 2));
  console.log("\n" + md);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`Backtest failed: ${(e as Error).message}`);
    process.exit(1);
  });
}
