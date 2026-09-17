// Smoke test: calls Jev through Vercel AI Gateway directly (no browser, no UI).
// Checks that the call succeeds and that Jev's choices follow the Wordle feedback it is given.
import { experimental_evaluate as evaluate } from 'ai';
import { gateway } from '@ai-sdk/gateway';
import { MODEL_ID, hasGatewayKey } from './lib/jev.mjs';

if (!hasGatewayKey()) { console.error('FAIL: AI_GATEWAY_API_KEY is not set'); process.exit(1); }
const model = gateway.evaluationModel(MODEL_ID);
console.log(`model: ${MODEL_ID}\n`);

const cases = [
  {
    name: 'green letter is reused in its square',
    state: 'Wordle, guess 2 of 6.\nGuess 1: C=grey R=grey A=green N=grey E=grey\n' +
      'Current guess so far: "__". Choosing the letter for square 3.',
    criteria: {
      a: 'Letter A: confirmed green in square 3; keeps 40 of 40 possible words.',
      o: 'Letter O: not tried yet; keeps 0 of 40 possible words.',
      r: 'Letter R: grey (not in the word); keeps 0 of 40 possible words.',
    },
    expect: 'a',
  },
  {
    name: 'grey letter is avoided',
    state: 'Wordle, guess 2 of 6.\nGuess 1: C=grey R=grey A=yellow N=grey E=grey\n' +
      'Current guess so far: "_". Choosing the letter for square 1.',
    criteria: {
      c: 'Letter C: grey in guess 1, so it is not in the word.',
      s: 'Letter S: not tried yet; keeps 120 of 300 possible words.',
      e: 'Letter E: grey in guess 1, so it is not in the word.',
    },
    expect: 's',
  },
  {
    name: 'only word-completing letter',
    state: 'Wordle, guess 4 of 6.\nGuess 1: S=grey T=grey A=grey I=grey D=grey\nGuess 2: C=grey O=grey U=grey C=grey H=green\n' +
      'Guess 3: G=grey L=grey Y=yellow P=green H=green\nCurrent guess so far: "NYMP_". Choosing the letter for square 5.',
    criteria: {
      h: 'Letter H: confirmed green in square 5; completes NYMPH, the only possible word.',
      s: 'Letter S: grey in guess 1, not in the word; NYMPS is not a valid answer.',
    },
    expect: 'h',
  },
];

let failed = 0;
for (const c of cases) {
  const t = Date.now();
  try {
    const { answers, usage, response } = await evaluate({
      model,
      state: c.state,
      questions: {
        letter: {
          type: 'choice',
          instructions: 'Pick the letter for this square that gives the best chance of solving the puzzle. Green = right letter, right square; yellow = in the word, different square; grey = not in the word.',
          criteria: c.criteria,
        },
      },
    });
    const { choice, probabilities } = answers.letter;
    const ok = choice === c.expect;
    if (!ok) failed++;
    const probs = probabilities ? Object.entries(probabilities).sort((a, b) => b[1] - a[1]).map(([l, p]) => `${l}=${(p * 100).toFixed(1)}%`).join(' ') : '(no probabilities returned)';
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}`);
    console.log(`      chose "${choice}" (expected "${c.expect}")  ${probs}`);
    console.log(`      ${Date.now() - t}ms  tokens=${JSON.stringify(usage)}  modelId=${response?.modelId ?? '?'}\n`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${c.name}\n      ${err?.data?.error?.message ?? err.message}\n`);
  }
}
console.log(failed ? `${failed}/${cases.length} failed` : `all ${cases.length} passed`);
process.exit(failed ? 1 : 0);
