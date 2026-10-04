# Deriv SMC/ICT bot (Cloudflare Worker)

Private backend bot. A cron trigger fires every 5 minutes, scans forex/gold on Deriv, and
opens **multiplier** trades (MULTUP/MULTDOWN) with a real stop loss and take profit when an
SMC/ICT setup is confirmed. No public UI; the only HTTP routes need `ADMIN_TOKEN`.

## Strategy (top-down, confirmation based)

Three trading styles run side by side, long and short:

| Style    | Bias | Setup | Entry | Min / max RR | Risk | Extra |
|----------|------|-------|-------|--------------|------|-------|
| scalp    | 15M  | 5M    | 1M    | 1.5 / 3      | 0.5x | kill zone required |
| intraday | 1H   | 15M   | 5M    | 2 / 4        | 1x   | |
| swing    | 4H   | 1H    | 15M   | 3 / 6        | 1x   | |

A trade needs three mandatory confirmations: higher-timeframe bias (last BOS/CHoCH), price
tapping an unmitigated order block or FVG on the setup timeframe, then a structure break in the
bias direction on the entry timeframe. On top of that it needs `MIN_CONFLUENCE` (default 4 of 6)
points: liquidity sweep, discount/premium alignment, kill zone, displacement candle on the break,
OB+FVG overlap, setup-timeframe trend aligned.

Stop sits beyond the POI/sweep plus 0.25 ATR. Target is the nearest unswept swing high/low that
gives the style's minimum RR. Kill zones (New York time, DST-aware): London 02:00-05:00, NY AM 07:00-10:00.

## Balance, risk and leverage

Every run reads the account balance. On Deriv multipliers the real position size is
`stake x multiplier` (notional). Sizing solves for the notional where the loss at the stop equals
the risk amount, then shrinks it until all of these hold:

- `RISK_PCT` of balance per trade (scalps use half)
- `MAX_TOTAL_RISK_PCT` across all open trades (default 2%)
- `MAX_LEVERAGE` total open notional / balance (default 20x)
- `MAX_STAKE_PCT` of balance tied up as stake
- stop-loss amount always below the stake

Also: `MAX_OPEN` positions (one per symbol), `MAX_TRADES_PER_DAY`, stop after
`MAX_CONSEC_LOSSES`, stop at `DAILY_LOSS_PCT` drawdown. No Martingale. The stop and target are
attached to the contract on Deriv's side, so they work even if the Worker is down.

## Free Cloudflare plan

The free plan allows about 10 ms CPU per invocation. The Worker uses three staggered crons
(minute offsets 0, 1, 2 of every 5), each scanning one symbol, so each run has its own budget.
Cron N scans `SYMBOLS[N]`, so use at most 3 symbols. Waiting on Deriv does not count as CPU.
If `wrangler tail` shows "exceeded CPU", drop a profile (`PROFILES`) or the candle count.
Because crons fire at most once a minute, scalps are checked every 5 minutes with a few minutes
of lag. It is a fast intraday style, not tick scalping.

## Optional AI second opinion

When a setup passes all rules, the bot sends the numbers (levels, confluence, recent candles) to a
model, which replies approve or reject and may shrink the size to 25-100%. It can never change
direction, stop, target or add risk. If the call fails the trade is skipped (`AI_FAIL_MODE=approve` flips that).
It only runs when a real setup appears.

- `AI_PROVIDER=workers-ai` (default): Cloudflare's hosted open models, free daily allowance, no key.
  Default model `@cf/openai/gpt-oss-120b` (a 120B reasoning model). Set `AI_MODEL` to any other catalog model; note that some, like Kimi K2.6, are not available on the free Workers billing.
- `AI_PROVIDER=claude`: Anthropic API (default `claude-fable-5-1`), stronger but billed. Needs
  `npx wrangler secret put ANTHROPIC_API_KEY`.

Set `AI_GATE=false` to run on rules alone.

## Deploy

1. Register an app and create a PAT (scopes `trade`, `account_manage`) at https://developers.deriv.com.
   Get your account ID with `GET https://api.derivws.com/trading/v1/options/accounts`.
2. `npm install`
3. Edit `wrangler.jsonc`: set `DERIV_APP_ID` and `DERIV_ACCOUNT_ID` (use a **demo** account first).
4. Secrets:
   ```
   npx wrangler secret put DERIV_TOKEN
   npx wrangler secret put ADMIN_TOKEN
   # optional Telegram alerts
   npx wrangler secret put TELEGRAM_BOT_TOKEN
   npx wrangler secret put TELEGRAM_CHAT_ID
   # only if AI_PROVIDER=claude
   npx wrangler secret put ANTHROPIC_API_KEY
   ```
5. `npx wrangler deploy`, then `npx wrangler tail` to watch the logs.

`DRY_RUN` is `"true"` by default: the bot logs (and optionally sends) signals but places no
orders. Watch a few sessions, then set `DRY_RUN` to `"false"` and redeploy.

## Admin routes

```
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://<worker>.workers.dev/status
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" https://<worker>.workers.dev/run     # scan now (add ?symbol=frxEURUSD)
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" https://<worker>.workers.dev/halt
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" https://<worker>.workers.dev/resume
```

## Notes

- Multiplier proposal fields (`underlying_symbol` for the new API, `symbol` for legacy) and the
  OTP response shape follow Deriv's current docs but were not run against the live API. Verify
  on a demo account with `DRY_RUN=false` before trusting it.
- `DERIV_API_MODE=legacy` uses `ws.derivws.com` with `authorize` for older app IDs/tokens.
- Tests: `npm test` (SMC engine, sizing, risk gates).
