// Jev via Vercel AI Gateway: model setup, a forgiving ask(), and usage/cost tracking.
import path from 'node:path';
import { experimental_evaluate as evaluate } from 'ai';
import { gateway } from '@ai-sdk/gateway';
import { ROOT } from './wordle.mjs';

try { process.loadEnvFile(path.join(ROOT, '.env')); } catch {}

export const MODEL_ID = process.env.JEV_MODEL || 'typesafe-ai/jev';
export const PRICE_PER_INPUT_TOKEN = 0.042 / 1e6; // Vercel AI Gateway list price; output tokens are not priced
const CALL_TIMEOUT_MS = 30_000; // a Jev call normally takes 0.2–1s; a hung request is abandoned and retried
const CALL_RETRIES = 2;
export const hasGatewayKey = () => !!(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN);

/** Answers sorted by probability, highest first: [[option, p], …]. */
export const ranked = answer => Object.entries(answer.probabilities ?? { [answer.choice]: 1 }).sort((a, b) => b[1] - a[1]);

/**
 * A Jev client for one game. `ask(state, questions)` returns the answers map.
 * Jev occasionally reports a choice that isn't its top-probability option (near-ties like 0.10 vs 0.11),
 * which the AI SDK rejects; those answers are recovered from the error using the top-probability option.
 * Recovered calls come back without usage, so they're counted as unmetered.
 * Each call times out after 30s and is retried up to twice; `signal` (e.g. the game being stopped) cancels it.
 */
export function createJev(modelId = MODEL_ID) {
  const model = gateway.evaluationModel(modelId);
  const totals = { calls: 0, unmeteredCalls: 0, timedOutCalls: 0, inputTokens: 0, outputTokens: 0, callMs: [] };

  async function ask(state, questions, { signal } = {}) {
    totals.calls++;
    for (let retry = 0; ; retry++) {
      const timeout = AbortSignal.timeout(CALL_TIMEOUT_MS);
      try {
        return await askOnce(state, questions, signal ? AbortSignal.any([signal, timeout]) : timeout);
      } catch (err) {
        if (!timeout.aborted || signal?.aborted) throw err;
        totals.timedOutCalls++;
        if (retry >= CALL_RETRIES) throw new Error(`Jev call timed out ${retry + 1} times (${CALL_TIMEOUT_MS / 1000}s each)`);
      }
    }
  }

  async function askOnce(state, questions, abortSignal) {
    const started = Date.now();
    try {
      const { answers, usage } = await evaluate({ model, state, questions, abortSignal });
      totals.callMs.push(Date.now() - started);
      totals.inputTokens += usage?.inputTokens ?? 0;
      totals.outputTokens += usage?.outputTokens ?? 0;
      return answers;
    } catch (err) {
      if (err?.name !== 'AI_InvalidResponseDataError' || !err.data) throw err;
      totals.callMs.push(Date.now() - started);
      totals.unmeteredCalls++;
      return Object.fromEntries(Object.entries(err.data).map(([k, a]) =>
        [k, a.probabilities ? { ...a, choice: ranked(a)[0][0] } : a]));
    }
  }

  return { ask, totals, cost: () => totals.inputTokens * PRICE_PER_INPUT_TOKEN };
}
