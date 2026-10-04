import { getStatus, runBot, setHalt } from "./bot.ts";
import { loadConfig, type Env } from "./config.ts";

export { BotState } from "./botstate.ts";

// Must match wrangler.jsonc. Each cron is its own invocation with its own CPU budget,
// so on the free plan every cron scans ONE symbol (cron N -> symbol N).
const CRONS = ["0-59/5 * * * *", "1-59/5 * * * *", "2-59/5 * * * *"];

function authorized(req: Request, env: Env): boolean {
  if (!env.ADMIN_TOKEN) return false; // admin routes stay off until a token is set
  return (req.headers.get("authorization") ?? "") === `Bearer ${env.ADMIN_TOKEN}`;
}

export default {
  async scheduled(ev: ScheduledController, env: Env, ctx: ExecutionContext) {
    const slot = CRONS.indexOf(ev.cron);
    const symbol = loadConfig(env).symbols[slot < 0 ? 0 : slot];
    if (!symbol) return;
    ctx.waitUntil(
      runBot(env, `cron${slot}`, { symbols: [symbol] }).catch((e) => console.error("run failed:", (e as Error).message)),
    );
  },

  // Private admin API (bearer ADMIN_TOKEN). Anything else looks like a 404.
  async fetch(req: Request, env: Env): Promise<Response> {
    if (!authorized(req, env)) return new Response("Not found", { status: 404 });
    const url = new URL(req.url);
    if (url.pathname === "/status") return Response.json(await getStatus(env));
    if (url.pathname === "/run" && req.method === "POST") {
      const only = url.searchParams.get("symbol");
      return Response.json(await runBot(env, "manual", { symbols: only ? [only] : undefined, force: true }));
    }
    if (url.pathname === "/halt" && req.method === "POST") return Response.json(await setHalt(env, true));
    if (url.pathname === "/resume" && req.method === "POST") return Response.json(await setHalt(env, false));
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
