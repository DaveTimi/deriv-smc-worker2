import { aiReview } from "./ai.ts";
import { loadConfig, type Env } from "./config.ts";
import type { Candle } from "./smc.ts";
import { buyMultiplier, closedOnly, connectDeriv, getBalance, getCandles, getContractStatus, getMultiplierRange } from "./deriv.ts";
import { gateReason, sizeMultiplier } from "./risk.ts";
import { evaluate } from "./strategy.ts";

export interface RunReport {
  logs: string[];
}

export interface RunOptions {
  symbols?: string[]; // limit this run to these symbols (cron runs one symbol each)
  force?: boolean; // ignore the per-profile evaluation cadence (manual runs)
}

async function notify(env: Env, text: string) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }),
    });
  } catch {
    /* notifications are best-effort */
  }
}

const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export async function runBot(env: Env, source: string, opts: RunOptions = {}): Promise<RunReport> {
  const logs: string[] = [];
  const log = (m: string) => {
    logs.push(m);
    console.log(`[${source}] ${m}`);
  };

  const cfg = loadConfig(env);
  const nowMs = Date.now();
  const store = env.BOT_STATE.get(env.BOT_STATE.idFromName("main"));
  const st = await store.load(dayKey(nowMs));

  if (st.manualHalt) {
    log("manually halted (use /resume)");
    return { logs };
  }
  const symbols = opts.symbols ?? cfg.symbols;
  if (!symbols.length) return { logs };

  const ws = await connectDeriv(env, cfg);
  try {
    const { balance, currency } = await getBalance(ws);
    if (!st.startBalance) st.startBalance = balance;

    // 1) settle closed positions (stop/target are enforced by Deriv itself)
    for (const pos of [...st.open]) {
      try {
        const c = await getContractStatus(ws, pos.contractId);
        if (!c.isSold) continue;
        st.consecLosses = c.profit < 0 ? st.consecLosses + 1 : 0;
        st.open = st.open.filter((p) => p.contractId !== pos.contractId);
        const msg = `Closed ${pos.symbol} ${pos.profile} ${pos.dir} #${pos.contractId}: ${c.profit >= 0 ? "+" : ""}${c.profit.toFixed(2)} ${currency}`;
        log(msg);
        await notify(env, msg);
      } catch (e) {
        log(`status check #${pos.contractId} failed: ${(e as Error).message}`);
      }
    }

    // 2) account-level gates
    const blocked = gateReason(st, balance, cfg);
    if (blocked) {
      log(`no new trades: ${blocked}`);
      await store.save(st);
      return { logs };
    }

    const minute = new Date(nowMs).getUTCMinutes();
    const cache = new Map<string, Candle[]>();
    const candles = async (symbol: string, gran: number) => {
      const k = `${symbol}:${gran}`;
      let v = cache.get(k);
      if (!v) {
        v = closedOnly(await getCandles(ws, symbol, gran, cfg.candleCount), gran, nowMs);
        cache.set(k, v);
      }
      return v;
    };

    // 3) scan
    for (const symbol of symbols) {
      if (st.open.length >= cfg.maxOpen) {
        log(`max ${cfg.maxOpen} open positions reached`);
        break;
      }
      if (st.open.some((p) => p.symbol === symbol)) {
        log(`${symbol}: already has an open position`);
        continue;
      }
      for (const profile of cfg.profiles) {
        if (!opts.force && minute % profile.evalEveryMin >= 5) continue;
        try {
          const [htf, mtf, ltf] = [
            await candles(symbol, profile.htf),
            await candles(symbol, profile.mtf),
            await candles(symbol, profile.ltf),
          ];
          const lastLtf = ltf[ltf.length - 1];
          if (!lastLtf || nowMs - (lastLtf.t + profile.ltf) * 1000 > Math.max(3 * profile.ltf, 300) * 1000) {
            log(`${symbol} ${profile.name}: stale data (market closed?)`);
            continue;
          }

          const ev = evaluate(symbol, profile, htf, mtf, ltf, cfg, nowMs);
          if (!ev.signal) {
            log(`${symbol} ${profile.name}: no setup (${ev.why})`);
            continue;
          }
          const s = ev.signal;
          if (st.handled.includes(s.signalKey)) continue;

          // AI second opinion (optional): may reject or shrink, never enlarge
          let sizeFactor = 1;
          let aiNote = "";
          if (cfg.aiGate) {
            const v = await aiReview(env, cfg, s, { htf, mtf, ltf });
            aiNote = ` | AI ${v.approve ? "approved" : "rejected"} x${v.sizeFactor}: ${v.reason}`;
            if (!v.approve) {
              st.handled.push(s.signalKey);
              log(`${symbol} ${profile.name}: setup vetoed${aiNote}`);
              continue;
            }
            sizeFactor = v.sizeFactor;
          }

          const range = (await getMultiplierRange(ws, cfg, symbol)) ?? cfg.fallbackMultipliers;
          const size = sizeMultiplier({
            balance,
            riskPct: cfg.riskPct * profile.riskScale,
            entry: s.entry,
            sl: s.sl,
            rr: s.rr,
            multipliers: range,
            maxStakePct: cfg.maxStakePct,
            maxLeverage: cfg.maxLeverage,
            maxTotalRiskPct: cfg.maxTotalRiskPct,
            openRisk: sum(st.open.map((p) => p.risk)),
            openNotional: sum(st.open.map((p) => p.notional)),
            openStake: sum(st.open.map((p) => p.stake)),
            sizeFactor,
          });
          const desc =
            `${symbol} ${profile.name} ${s.dir === "bull" ? "BUY" : "SELL"} @ ${s.entry} SL ${s.sl.toFixed(5)} TP ${s.tp.toFixed(5)} ` +
            `RR ${s.rr.toFixed(2)} | ${s.trigger} off ${s.poi.kind} | ${s.confluence.join(", ")}`;
          if (!size) {
            log(`${symbol} ${profile.name}: setup found but exposure limits leave no room (${desc})`);
            continue;
          }
          const sizeDesc = `stake ${size.stake} x${size.multiplier} (${size.leverage}x of balance), risk ${size.riskAmount} ${currency}, SL ${size.stopLoss}, TP ${size.takeProfit}`;

          st.handled.push(s.signalKey);
          if (cfg.dryRun) {
            const msg = `[DRY RUN] ${desc} | ${sizeDesc}${aiNote}`;
            log(msg);
            await notify(env, msg);
            continue;
          }

          const buy = await buyMultiplier(ws, cfg, {
            symbol,
            dir: s.dir,
            stake: size.stake,
            multiplier: size.multiplier,
            stopLoss: size.stopLoss,
            takeProfit: size.takeProfit,
            currency,
          });
          st.open.push({
            contractId: buy.contractId,
            symbol,
            profile: profile.name,
            dir: s.dir,
            openedAt: nowMs,
            risk: size.riskAmount,
            notional: size.notional,
            stake: size.stake,
          });
          st.tradesToday += 1;
          const msg = `OPENED #${buy.contractId} ${desc} | ${sizeDesc}${aiNote}`;
          log(msg);
          await notify(env, msg);
          break; // one position per symbol
        } catch (e) {
          log(`${symbol} ${profile.name}: error ${(e as Error).message}`);
        }
      }
    }

    await store.save(st);
  } finally {
    ws.close();
  }
  return { logs };
}

export async function getStatus(env: Env) {
  const store = env.BOT_STATE.get(env.BOT_STATE.idFromName("main"));
  const cfg = loadConfig(env);
  return {
    config: { dryRun: cfg.dryRun, profiles: cfg.profiles.map((p) => p.name), symbols: cfg.symbols, aiGate: cfg.aiGate, maxLeverage: cfg.maxLeverage },
    state: await store.load(dayKey(Date.now())),
  };
}

export async function setHalt(env: Env, halted: boolean) {
  const store = env.BOT_STATE.get(env.BOT_STATE.idFromName("main"));
  const st = await store.load(dayKey(Date.now()));
  st.manualHalt = halted;
  await store.save(st);
  return st;
}
