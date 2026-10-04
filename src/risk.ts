export interface SizeInput {
  balance: number;
  riskPct: number; // already scaled by the profile
  entry: number;
  sl: number;
  rr: number;
  multipliers: number[];
  maxStakePct: number;
  maxLeverage: number; // cap on total open notional / balance
  maxTotalRiskPct: number; // cap on total open risk / balance
  openRisk: number;
  openNotional: number;
  openStake: number;
  sizeFactor?: number; // 0..1, e.g. from the AI reviewer; can only shrink the trade
}

export interface Sized {
  multiplier: number;
  stake: number;
  stopLoss: number; // currency amount for Deriv limit_order.stop_loss
  takeProfit: number; // currency amount for Deriv limit_order.take_profit
  riskAmount: number;
  notional: number;
  leverage: number; // this trade's notional / balance
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Deriv multipliers: P/L = stake * multiplier * (price move / entry).
 * Notional (stake x multiplier) is what the position is really worth, so
 *   loss at stop = notional * stopDistance/entry   ->   notional = risk / stopFraction.
 * Risk is shrunk until total risk, total leverage and total stake caps all hold, then the
 * largest allowed multiplier whose stake still sits above the stop-loss amount is used.
 */
export function sizeMultiplier(i: SizeInput): Sized | null {
  const slFrac = Math.abs(i.entry - i.sl) / i.entry;
  if (!(i.balance > 0) || !(slFrac > 0)) return null;

  let risk = ((i.balance * i.riskPct) / 100) * Math.min(1, Math.max(0, i.sizeFactor ?? 1));
  risk = Math.min(risk, (i.balance * i.maxTotalRiskPct) / 100 - i.openRisk);
  if (!(risk > 0)) return null;

  let notional = risk / slFrac;
  const levRoom = i.maxLeverage * i.balance - i.openNotional;
  if (!(levRoom > 0)) return null;
  if (notional > levRoom) {
    notional = levRoom;
    risk = notional * slFrac;
  }

  const stakeRoom = (i.balance * i.maxStakePct) / 100 - i.openStake;
  for (const m of [...i.multipliers].sort((a, b) => b - a)) {
    const stake = notional / m;
    if (stake < risk * 1.05) continue; // stop_loss must sit inside the stake
    if (stake > stakeRoom) continue;
    return {
      multiplier: m,
      stake: r2(stake),
      stopLoss: r2(risk),
      takeProfit: r2(risk * i.rr),
      riskAmount: r2(risk),
      notional: r2(stake * m),
      leverage: r2((stake * m) / i.balance),
    };
  }
  return null;
}

export interface DayGate {
  day: string;
  startBalance: number;
  tradesToday: number;
  consecLosses: number;
}

export function gateReason(
  s: DayGate,
  balance: number,
  cfg: { maxTradesPerDay: number; maxConsecLosses: number; dailyLossPct: number },
): string | null {
  if (s.tradesToday >= cfg.maxTradesPerDay) return `max ${cfg.maxTradesPerDay} trades/day reached`;
  if (s.consecLosses >= cfg.maxConsecLosses) return `${cfg.maxConsecLosses} consecutive losses`;
  if (s.startBalance > 0 && ((s.startBalance - balance) / s.startBalance) * 100 >= cfg.dailyLossPct)
    return `daily loss limit ${cfg.dailyLossPct}% hit`;
  return null;
}
