import type { BotState } from "./botstate.ts";

export interface Env {
  BOT_STATE: DurableObjectNamespace<BotState>;

  // secrets
  DERIV_TOKEN: string;
  ADMIN_TOKEN?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  ANTHROPIC_API_KEY?: string;
  AI?: Ai; // Cloudflare Workers AI binding

  // vars
  DERIV_API_MODE?: string;
  DERIV_APP_ID: string;
  DERIV_ACCOUNT_ID?: string;
  DRY_RUN?: string;
  SYMBOLS?: string;
  PROFILES?: string;
  RISK_PCT?: string;
  MAX_TRADES_PER_DAY?: string;
  MAX_CONSEC_LOSSES?: string;
  DAILY_LOSS_PCT?: string;
  MAX_OPEN?: string;
  MAX_TOTAL_RISK_PCT?: string;
  MAX_LEVERAGE?: string;
  MAX_STAKE_PCT?: string;
  MIN_CONFLUENCE?: string;
  FALLBACK_MULTIPLIERS?: string;
  AI_GATE?: string;
  AI_PROVIDER?: string;
  AI_MODEL?: string;
  AI_FAIL_MODE?: string;
}

export type ProfileName = "scalp" | "intraday" | "swing";

export interface Profile {
  name: ProfileName;
  htf: number; // bias timeframe (seconds)
  mtf: number; // setup timeframe
  ltf: number; // entry confirmation timeframe
  minRR: number;
  maxRR: number;
  riskScale: number; // multiplies RISK_PCT
  killzoneRequired: boolean;
  evalEveryMin: number; // only evaluate when UTC minute % this < 5 (keeps CPU low on the free plan)
}

export const PROFILES: Record<ProfileName, Profile> = {
  scalp: { name: "scalp", htf: 900, mtf: 300, ltf: 60, minRR: 1.5, maxRR: 3, riskScale: 0.5, killzoneRequired: true, evalEveryMin: 5 },
  intraday: { name: "intraday", htf: 3600, mtf: 900, ltf: 300, minRR: 2, maxRR: 4, riskScale: 1, killzoneRequired: false, evalEveryMin: 5 },
  swing: { name: "swing", htf: 14400, mtf: 3600, ltf: 900, minRR: 3, maxRR: 6, riskScale: 1, killzoneRequired: false, evalEveryMin: 15 },
};

export interface Config {
  apiMode: "new" | "legacy";
  appId: string;
  accountId?: string;
  dryRun: boolean;
  symbols: string[];
  profiles: Profile[];
  riskPct: number;
  maxTradesPerDay: number;
  maxConsecLosses: number;
  dailyLossPct: number;
  maxOpen: number;
  maxTotalRiskPct: number;
  maxLeverage: number; // max notional (stake x multiplier) as a multiple of balance
  maxStakePct: number;
  minConfluence: number;
  fallbackMultipliers: number[];
  aiGate: boolean;
  aiProvider: "workers-ai" | "claude";
  aiModel: string;
  aiFailClosed: boolean;
  candleCount: number;
  pivotLenHTF: number;
  pivotLenMTF: number;
  pivotLenLTF: number;
  dispMult: number;
  entryWindow: number;
  entryFresh: number;
  sweepLookback: number;
  poiLookback: number;
  slBufferAtr: number;
  minSlAtr: number;
  maxSlAtr: number;
}

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) ? n : d;
};

export function loadConfig(env: Env): Config {
  const wanted = (env.PROFILES ?? "scalp,intraday,swing").split(",").map((s) => s.trim());
  const profiles = (Object.keys(PROFILES) as ProfileName[]).filter((k) => wanted.includes(k)).map((k) => PROFILES[k]);
  const aiProvider = env.AI_PROVIDER?.toLowerCase() === "claude" ? "claude" : "workers-ai";
  return {
    apiMode: env.DERIV_API_MODE === "legacy" ? "legacy" : "new",
    appId: env.DERIV_APP_ID,
    accountId: env.DERIV_ACCOUNT_ID,
    // anything other than an explicit "false" keeps the bot in dry-run
    dryRun: env.DRY_RUN?.toLowerCase() !== "false",
    symbols: (env.SYMBOLS ?? "frxEURUSD").split(",").map((s) => s.trim()).filter(Boolean),
    profiles,
    riskPct: num(env.RISK_PCT, 1),
    maxTradesPerDay: num(env.MAX_TRADES_PER_DAY, 4),
    maxConsecLosses: num(env.MAX_CONSEC_LOSSES, 3),
    dailyLossPct: num(env.DAILY_LOSS_PCT, 3),
    maxOpen: num(env.MAX_OPEN, 2),
    maxTotalRiskPct: num(env.MAX_TOTAL_RISK_PCT, 2),
    maxLeverage: num(env.MAX_LEVERAGE, 20),
    maxStakePct: num(env.MAX_STAKE_PCT, 25),
    minConfluence: num(env.MIN_CONFLUENCE, 4),
    fallbackMultipliers: (env.FALLBACK_MULTIPLIERS ?? "30,50,100,200,300,500")
      .split(",")
      .map(Number)
      .filter((n) => Number.isFinite(n) && n > 0),
    aiGate: env.AI_GATE?.toLowerCase() === "true" && (aiProvider === "claude" ? !!env.ANTHROPIC_API_KEY : !!env.AI),
    aiProvider,
    aiModel: env.AI_MODEL || (aiProvider === "claude" ? "claude-fable-5-1" : "@cf/openai/gpt-oss-120b"),
    aiFailClosed: env.AI_FAIL_MODE?.toLowerCase() !== "approve",
    candleCount: 150,
    pivotLenHTF: 3,
    pivotLenMTF: 3,
    pivotLenLTF: 2,
    dispMult: 1.0,
    entryWindow: 30,
    entryFresh: 6,
    sweepLookback: 32,
    poiLookback: 80,
    slBufferAtr: 0.25,
    minSlAtr: 0.3,
    maxSlAtr: 3.0,
  };
}
