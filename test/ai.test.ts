import { test } from "node:test";
import assert from "node:assert/strict";
import { aiReview } from "../src/ai.ts";
import { loadConfig } from "../src/config.ts";

const sig: any = {
  symbol: "frxEURUSD", profile: "intraday", dir: "bull", entry: 1.1, sl: 1.098, tp: 1.104, rr: 2,
  poi: { kind: "OB", top: 1.099, bottom: 1.098 }, sweep: null, trigger: "CHoCH", session: null, confluence: ["a"], signalKey: "k",
};
const data = { htf: [], mtf: [], ltf: [] } as any;
const envWith = (reply: unknown, extra: Record<string, string> = {}) =>
  ({ DERIV_APP_ID: "1", DERIV_TOKEN: "x", AI_GATE: "true", AI: { run: async () => reply }, ...extra }) as any;

test("workers-ai approve with smaller size", async () => {
  const env = envWith({ response: 'Sure: {"decision":"approve","size_factor":0.5,"reason":"ok"}' });
  const v = await aiReview(env, loadConfig(env), sig, data);
  assert.deepEqual([v.approve, v.sizeFactor], [true, 0.5]);
});

test("size factor is clamped and cannot exceed 1", async () => {
  const env = envWith({ response: '{"decision":"approve","size_factor":9,"reason":"x"}' });
  assert.equal((await aiReview(env, loadConfig(env), sig, data)).sizeFactor, 1);
});

test("reject is respected", async () => {
  const env = envWith({ response: '{"decision":"reject","size_factor":1,"reason":"choppy"}' });
  assert.equal((await aiReview(env, loadConfig(env), sig, data)).approve, false);
});

test("garbage reply fails closed by default and open when configured", async () => {
  const env = envWith({ response: "no json here" });
  assert.equal((await aiReview(env, loadConfig(env), sig, data)).approve, false);
  const env2 = envWith({ response: "no json here" }, { AI_FAIL_MODE: "approve" });
  assert.equal((await aiReview(env2, loadConfig(env2), sig, data)).approve, true);
});

test("gate is off without the AI binding", () => {
  const cfg = loadConfig({ DERIV_APP_ID: "1", DERIV_TOKEN: "x", AI_GATE: "true" } as any);
  assert.equal(cfg.aiGate, false);
});

import { extractVerdict, replyText } from "../src/ai.ts";

test("extractVerdict ignores reasoning text and braces around the answer", () => {
  const raw = '<think>maybe {weird} thoughts</think> Final: {"decision":"approve","size_factor":0.75,"reason":"clean"}';
  assert.equal(extractVerdict(raw)?.decision, "approve");
  assert.equal(extractVerdict("nothing"), null);
});

test("replyText handles chat-completion and responses-api shapes", () => {
  assert.equal(replyText({ choices: [{ message: { content: "hi" } }] }), "hi");
  assert.equal(replyText({ response: "yo" }), "yo");
  const resp = { output: [{ type: "reasoning", content: [{ text: "thinking" }] }, { type: "message", content: [{ text: "answer" }] }] };
  assert.equal(replyText(resp), "answer");
});

test("workers-ai default model is gpt-oss-120b", () => {
  assert.equal(loadConfig({ DERIV_APP_ID: "1", DERIV_TOKEN: "x" } as any).aiModel, "@cf/openai/gpt-oss-120b");
});
