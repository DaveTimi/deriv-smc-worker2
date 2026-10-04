import type { Config, Env } from "./config.ts";
import type { Candle, Dir } from "./smc.ts";

// Request/response client over one WebSocket, matched by req_id.
export class DerivWS {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private closed = false;

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (ev: MessageEvent) => {
      let msg: any;
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
      } catch {
        return;
      }
      const p = this.pending.get(msg.req_id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(msg.req_id);
      if (msg.error) p.reject(new Error(`${msg.error.code ?? "error"}: ${msg.error.message ?? "unknown"}`));
      else p.resolve(msg);
    });
    const fail = () => {
      this.closed = true;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error("websocket closed"));
      }
      this.pending.clear();
    };
    ws.addEventListener("close", fail);
    ws.addEventListener("error", fail);
  }

  send<T = any>(payload: Record<string, unknown>, timeoutMs = 15000): Promise<T> {
    if (this.closed) return Promise.reject(new Error("websocket closed"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for ${Object.keys(payload)[0]}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ ...payload, req_id: id }));
    });
  }

  close() {
    try {
      this.ws.close(1000, "done");
    } catch {
      /* ignore */
    }
  }
}

async function openSocket(url: string): Promise<WebSocket> {
  // Workers open outbound WebSockets via fetch + Upgrade, using an https:// URL.
  const res = await fetch(url.replace(/^wss:/, "https:").replace(/^ws:/, "http:"), {
    headers: { Upgrade: "websocket" },
  });
  const ws = res.webSocket;
  if (!ws) throw new Error(`websocket upgrade failed (HTTP ${res.status})`);
  ws.accept();
  return ws as unknown as WebSocket;
}

export async function connectDeriv(env: Env, cfg: Config): Promise<DerivWS> {
  if (cfg.apiMode === "legacy") {
    const ws = new DerivWS(await openSocket(`wss://ws.derivws.com/websockets/v3?app_id=${encodeURIComponent(cfg.appId)}`));
    await ws.send({ authorize: env.DERIV_TOKEN });
    return ws;
  }
  // New API: exchange the PAT for a one-time authenticated WebSocket URL.
  if (!cfg.accountId) throw new Error("DERIV_ACCOUNT_ID is required when DERIV_API_MODE=new");
  const res = await fetch(`https://api.derivws.com/trading/v1/options/accounts/${cfg.accountId}/otp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.DERIV_TOKEN}`, "Deriv-App-ID": cfg.appId },
  });
  if (!res.ok) throw new Error(`OTP request failed: HTTP ${res.status}`);
  const body = (await res.json()) as { data?: { url?: string } };
  const url = body.data?.url;
  if (!url) throw new Error("OTP response had no data.url");
  return new DerivWS(await openSocket(url));
}

// ---- helpers ----

const symKey = (cfg: Config) => (cfg.apiMode === "new" ? "underlying_symbol" : "symbol");

export async function getBalance(ws: DerivWS): Promise<{ balance: number; currency: string }> {
  const r = await ws.send({ balance: 1 });
  return { balance: Number(r.balance.balance), currency: String(r.balance.currency) };
}

export async function getCandles(ws: DerivWS, symbol: string, granularity: number, count: number): Promise<Candle[]> {
  const r = await ws.send({ ticks_history: symbol, style: "candles", granularity, count, end: "latest" });
  return (r.candles ?? []).map((k: any) => ({ t: Number(k.epoch), o: +k.open, h: +k.high, l: +k.low, c: +k.close }));
}

/** Keep only fully closed candles. */
export function closedOnly(c: Candle[], granularity: number, nowMs: number): Candle[] {
  return c.filter((k) => (k.t + granularity) * 1000 <= nowMs);
}

export async function getMultiplierRange(ws: DerivWS, cfg: Config, symbol: string): Promise<number[] | null> {
  try {
    const r = await ws.send({ contracts_for: symbol, currency: "USD" });
    const list: any[] = r.contracts_for?.available ?? [];
    const m = list.find((x) => x.contract_type === "MULTUP");
    const range = m?.multiplier_range;
    return Array.isArray(range) && range.length ? range.map(Number) : null;
  } catch {
    return null;
  }
}

export interface BuyResult {
  contractId: number;
  buyPrice: number;
  longcode?: string;
}

export async function buyMultiplier(
  ws: DerivWS,
  cfg: Config,
  p: { symbol: string; dir: Dir; stake: number; multiplier: number; stopLoss: number; takeProfit: number; currency: string },
): Promise<BuyResult> {
  const prop = await ws.send({
    proposal: 1,
    amount: p.stake,
    basis: "stake",
    contract_type: p.dir === "bull" ? "MULTUP" : "MULTDOWN",
    currency: p.currency,
    multiplier: p.multiplier,
    [symKey(cfg)]: p.symbol,
    limit_order: { stop_loss: p.stopLoss, take_profit: p.takeProfit },
  });
  const quote = prop.proposal;
  // cap the price so a requote can't leave us paying more than ~1% over the quote
  const maxPrice = Math.round(Number(quote.ask_price) * 1.01 * 100) / 100;
  const buy = await ws.send({ buy: quote.id, price: maxPrice });
  return { contractId: Number(buy.buy.contract_id), buyPrice: Number(buy.buy.buy_price), longcode: buy.buy.longcode };
}

export interface ContractStatus {
  isSold: boolean;
  profit: number;
}

export async function getContractStatus(ws: DerivWS, contractId: number): Promise<ContractStatus> {
  const r = await ws.send({ proposal_open_contract: 1, contract_id: contractId });
  const c = r.proposal_open_contract;
  return { isSold: Number(c.is_sold) === 1, profit: Number(c.profit ?? 0) };
}
