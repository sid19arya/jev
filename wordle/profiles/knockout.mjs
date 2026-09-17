// Word knockout: code filters the answers that fit every clue; Jev picks which one to guess.
//
// Follows TypeSafe's guidance: "code handles deterministic work and owns the control flow", and Choice
// questions accept up to 255 options. When more words fit, a knockout round asks one Choice question per
// group of ≤255 in a single call (questions run in parallel and independently), then a final over the winners.
import { historyLines, rejectionLines } from '../lib/wordle.mjs';
import { ranked } from '../lib/jev.mjs';

const config = {
  maxOptions: 255,       // TypeSafe Choice limit
  maxAttempts: 10,       // guesses the game may reject in one turn before giving up (answers are always valid)
  knockoutPauseMs: 1200, // keep knockout results on screen before the final
  finalRowsShown: 8,
};

function buildPrompt({ turn, history, rejections, remaining }) {
  const lines = [
    `Game: Wordle. Guess ${turn} of 6. The hidden answer is a common 5-letter English word.`,
    'Previous guesses (green = right letter, right square; yellow = in the word, wrong square; grey = not in the word):',
    ...historyLines(history),
    `${remaining} possible answers still fit every clue; every option below is one of them.`,
  ];
  lines.push(...rejectionLines(rejections));
  return {
    state: lines.join('\n'),
    instructions: history.length
      ? 'Which word should be guessed next? Prefer the word most likely to be the answer: a common, everyday English word.'
      : 'Which word is the best opening guess? Prefer a common English word that could be the answer and uses frequent, distinct letters.',
  };
}

const choiceOver = (words, instructions) =>
  ({ type: 'choice', instructions, criteria: Object.fromEntries(words.map(w => [w, w.toUpperCase()])) });
const pct = p => `${Math.round(p * 100)}%`;
const secs = ms => `${(ms / 1000).toFixed(2)}s`;

export default {
  name: 'knockout',
  title: 'Word knockout',
  description: 'Code filters words that fit the clues; Jev picks the guess (knockout groups when >255 fit).',
  config,

  async guess(ctx) {
    const { turn, history, rejected, rejections } = ctx;
    const pool = ctx.candidates.filter(w => !rejected.includes(w));
    if (!pool.length) return null;
    const { state, instructions } = buildPrompt({ turn, history, rejections, remaining: pool.length });
    const status = `Guess ${turn}: ${pool.length} word${pool.length === 1 ? '' : 's'} fit every clue`;
    const sections = [];

    let finalists = pool;
    while (finalists.length > config.maxOptions) {
      const groups = [];
      for (let i = 0; i < finalists.length; i += config.maxOptions) groups.push(finalists.slice(i, i + config.maxOptions));
      const section = {
        title: `Knockout · ${finalists.length} words → ${groups.length} parallel questions`,
        pending: `asking ${groups.length} questions in one call…`, columns: 2, rows: [],
      };
      sections.push(section);
      await ctx.show(sections, status);

      const started = Date.now();
      const answers = await ctx.ask(state, Object.fromEntries(groups.map((g, i) => [`group_${i + 1}`, choiceOver(g, instructions)])));
      section.title += ` · ${secs(Date.now() - started)}`;
      section.pending = null;
      section.rows = groups.map((g, i) => {
        const a = answers[`group_${i + 1}`];
        return { prefix: `G${i + 1} ${g[0].toUpperCase()}–${g[g.length - 1].toUpperCase()}`, label: a.choice.toUpperCase(), p: a.probabilities?.[a.choice] ?? 1 };
      });
      finalists = groups.map((_, i) => answers[`group_${i + 1}`].choice);
      await ctx.show(sections, status);
      await ctx.wait(config.knockoutPauseMs);
    }

    const final = { title: `Final · ${finalists.length} word${finalists.length === 1 ? '' : 's'}`, pending: 'choosing…', rows: [] };
    sections.push(final);
    await ctx.show(sections, status);

    const started = Date.now();
    const { guess: answer } = await ctx.ask(state, { guess: choiceOver(finalists, instructions) });
    const guess = answer.choice, probs = ranked(answer), p = answer.probabilities?.[guess] ?? 1;
    final.title += ` · ${secs(Date.now() - started)}`;
    final.pending = null;
    final.rows = probs.slice(0, config.finalRowsShown).map(([w, q]) => ({ label: w.toUpperCase(), p: q, strong: w === guess }));
    final.more = Math.max(0, probs.length - config.finalRowsShown);
    for (const section of sections) for (const row of section.rows) if (row.label === guess.toUpperCase()) row.strong = true;
    await ctx.show(sections, `Guess ${turn}: Jev picked ${guess.toUpperCase()}`);

    return { word: guess, note: `picked from ${pool.length} at ${pct(p)}` };
  },
};
