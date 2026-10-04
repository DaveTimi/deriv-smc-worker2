import { DurableObject } from "cloudflare:workers";
import type { Env } from "./config.ts";
import type { Dir } from "./smc.ts";

export interface OpenPosition {
  contractId: number;
  symbol: string;
  profile: string;
  dir: Dir;
  openedAt: number;
  risk: number; // currency risked at the stop
  notional: number; // stake x multiplier
  stake: number;
}

export interface State {
  day: string; // UTC date the daily counters belong to
  startBalance: number; // 0 until the first balance read of the day
  tradesToday: number;
  consecLosses: number;
  manualHalt: boolean; // set via /halt, survives day rollover
  open: OpenPosition[];
  handled: string[]; // recent signal keys, to avoid re-entering the same setup
}

export const emptyState = (day: string): State => ({
  day,
  startBalance: 0,
  tradesToday: 0,
  consecLosses: 0,
  manualHalt: false,
  open: [],
  handled: [],
});

// One Durable Object instance holds the bot's counters so state is strongly consistent.
export class BotState extends DurableObject<Env> {
  async load(day: string): Promise<State> {
    const s = await this.ctx.storage.get<State>("state");
    if (!s) return emptyState(day);
    if (s.day !== day) {
      // new UTC day: reset daily counters, keep halt flag, open positions and handled keys
      return { ...emptyState(day), manualHalt: s.manualHalt, open: s.open ?? [], handled: s.handled ?? [] };
    }
    return s;
  }

  async save(s: State): Promise<void> {
    s.handled = s.handled.slice(-50);
    await this.ctx.storage.put("state", s);
  }
}
