// Bridge from the Python harness to Jev (typesafe-ai/jev) on Vercel AI Gateway.
// stdin:  {"model": "...", "state": <string|json>, "questions": {id: {type, instructions, criteria}}}
// stdout: {"answers": {id: {choice, probabilities}}, "usage": {...}, "recovered": bool}
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { experimental_evaluate as evaluate } from 'ai';
import { gateway } from '@ai-sdk/gateway';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch {}

const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const model = gateway.evaluationModel(input.model);
let out;
try {
  const { answers, usage } = await evaluate({ model, state: input.state, questions: input.questions });
  out = { answers, usage, recovered: false };
} catch (err) {
  // Jev occasionally reports a choice that isn't its top-probability option on near-ties, which the
  // SDK rejects. The raw answers are on the error; take the top-probability option instead.
  if (err?.name !== 'AI_InvalidResponseDataError' || !err.data) throw err;
  const answers = Object.fromEntries(Object.entries(err.data).map(([k, a]) =>
    [k, a.probabilities ? { ...a, choice: Object.entries(a.probabilities).sort((x, y) => y[1] - x[1])[0][0] } : a]));
  out = { answers, usage: null, recovered: true };
}
process.stdout.write(JSON.stringify(out));
