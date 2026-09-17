// Bridge from the Python harness to Jev (typesafe-ai/jev) on Vercel AI Gateway.
// stdin:  {"model": "...", "state": <string|json>, "questions": {id: {type, instructions, criteria}}}
// stdout: {"answers": {id: {choice, probabilities}}, "usage": {...}, "costUsd": number|null,
//          "apiMs": number|null, "adjusted": [question ids whose reported choice wasn't the top probability]}
//
// Calls the gateway model's doEvaluate directly rather than experimental_evaluate: Jev occasionally reports a
// choice that isn't its top-probability option on near-ties, which the SDK rejects (and then drops the usage
// and cost). Here we keep the raw result and take the top-probability option ourselves.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gateway } from '@ai-sdk/gateway';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch {}

const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const model = gateway.evaluationModel(input.model);
const started = Date.now();
const result = await model.doEvaluate({ state: input.state, questions: input.questions });
const wallMs = Date.now() - started;

const adjusted = [];
const answers = Object.fromEntries(Object.entries(result.answers).map(([id, a]) => {
  if (a.type !== 'choice' || !a.probabilities) return [id, a];
  const top = Object.entries(a.probabilities).sort((x, y) => y[1] - x[1])[0][0];
  if (top !== a.choice) adjusted.push(id);
  return [id, { ...a, choice: top }];
}));

const gw = result.providerMetadata?.gateway ?? {};
const attempt = gw.routing?.modelAttempts?.at(-1)?.providerAttempts?.at(-1);
const num = v => (v === undefined || v === null ? null : Number(v));
const usage = result.usage ?? {};
process.stdout.write(JSON.stringify({
  answers,
  usage: {
    inputTokens: num(usage.inputTokens?.total ?? usage.inputTokens),
    outputTokens: num(usage.outputTokens?.total ?? usage.outputTokens),
  },
  costUsd: num(gw.cost),
  apiMs: attempt ? attempt.endTime - attempt.startTime : wallMs,
  adjusted,
}));
