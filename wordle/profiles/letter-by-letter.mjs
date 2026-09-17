// Letter by letter: Jev chooses the guess one square at a time, in order, one Choice call per square.
// Nothing checks that the letters form a word, so Jev can spell non-words. The game rejects those ("Not in word
// list"), the row is cleared, and Jev tries again. Every rejected word stays in its state for the rest of the game.
//
// Letter pruning from the colored tiles (lib/wordle.mjs allowedLetters): a green square is filled without asking,
// a yellow letter is removed from the square it was yellow in, and a grey letter is removed everywhere (or only
// from its square when it's a duplicate of a letter that is in the word).
//
// To steer it toward real words without a word list, the instructions ask it to keep a specific real word in
// mind and only pick letters that can still finish one, and each option shows the word start it would create
// (e.g. "L: makes A E L _ _") so Jev can judge whether that start can become a real word.
//
// Kept as a reference point: Jev is a decision model, not a generator, so spelling a word one letter at a
// time is outside what it's built for. In testing it rarely produced a valid word (e.g. AERTS, AEDTR, COERT).
import { historyLines, rejectionLines, describeLetterClues, allowedLetters } from '../lib/wordle.mjs';
import { ranked } from '../lib/jev.mjs';

const config = {
  maxAttempts: 25,    // words the game may reject in one turn before giving up
  exploreTopK: 5,     // on retries, sample from Jev's top K letters…
  explorePower: 2,    // …weighted by probability^power, so strong favorites still dominate
  letterDelayMs: 250,
};

// The word start an option creates, e.g. prefix "ae" + "l" → "A E L _ _".
const wordShape = (prefix, letter) => [...(prefix + letter).toUpperCase().padEnd(5, '_')].join(' ');

// One option per letter: the word start it creates, then what the clues say about the letter.
const describeOption = (letter, pos, prefix, history) =>
  `${letter.toUpperCase()}: makes ${wordShape(prefix, letter)}${pos === 4 ? ' (the finished guess)' : ''}. Clues: ${describeLetterClues(letter, pos, history)}.`;

function buildQuestion({ turn, attempt, maxAttempts, pos, prefix, history, rejections, allowed }) {
  const fixed = [0, 1, 2, 3, 4].filter(i => allowed[i].length === 1);
  const lines = [
    `Game: Wordle. Guess ${turn} of 6. The hidden answer is a common 5-letter English word.`,
    'The game only accepts real 5-letter English words; anything else is rejected and must be retyped.',
    'Previous guesses (green = right letter, right square; yellow = in the word, wrong square; grey = not in the word):',
    ...historyLines(history),
    ...rejectionLines(rejections),
    `This is try ${attempt} of ${maxAttempts} for guess ${turn}.`,
    ...(fixed.length ? [`Confirmed by green tiles: ${fixed.map(i => `square ${i + 1} = ${allowed[i][0].toUpperCase()}`).join(', ')}.`] : []),
    'Letters ruled out by the colored tiles have been removed from the options.',
    `Word so far: ${[...prefix.toUpperCase().padEnd(5, '_')].join(' ')}`,
    `Now choosing the letter for square ${pos + 1} of 5.`,
  ];
  return {
    state: lines.join('\n'),
    question: {
      type: 'choice',
      instructions:
        'You are spelling a real 5-letter English word one letter at a time. ' +
        `Think of a specific, common English word that starts with the letters already typed and fits every clue, and choose its letter for square ${pos + 1}. ` +
        'Every letter must keep the word valid: only choose a letter if a real 5-letter English word can still be finished from the word start it makes. ' +
        'The word must still contain every yellow letter somewhere and keep the confirmed green letters. ' +
        'The letters already typed cannot change. Never spell a word the game already rejected.',
      criteria: Object.fromEntries(allowed[pos].map(l => [l, describeOption(l, pos, prefix, history)])),
    },
  };
}

// First try: Jev's top letter. Retries: sample from its top letters so a rejected word doesn't repeat.
function pickLetter(answer, explore) {
  const probs = ranked(answer);
  if (!explore) return answer.choice;
  const top = probs.slice(0, config.exploreTopK).map(([l, p]) => [l, p ** config.explorePower]);
  let r = Math.random() * top.reduce((sum, [, w]) => sum + w, 0);
  for (const [l, w] of top) if ((r -= w) <= 0) return l;
  return answer.choice;
}

const pct = p => `${Math.round(p * 100)}%`;

export default {
  name: 'letter-by-letter',
  title: 'Letter by letter',
  description: 'Jev picks each letter in order, one call per open square, letters pruned by the tiles; invalid words hit the wall.',
  config,

  async guess(ctx) {
    const { turn, attempt, maxAttempts, history, rejections } = ctx;
    const allowed = allowedLetters(history);
    const open = allowed.filter(a => a.length > 1).length;
    const section = { title: `Try ${attempt}/${maxAttempts} · ${open} call${open === 1 ? '' : 's'}, one per open square`, rows: [] };
    const status = `Guess ${turn}, try ${attempt}: choosing letters`;

    let prefix = '';
    for (let pos = 0; pos < 5; pos++) {
      let pick;
      if (allowed[pos].length === 1) {
        pick = allowed[pos][0];
        section.rows.push({ prefix: `sq ${pos + 1}`, label: pick.toUpperCase(), p: 1, note: 'green: only option' });
      } else {
        section.pending = `square ${pos + 1}: choosing from ${allowed[pos].length} letters…`;
        await ctx.show([section], status);
        const { state, question } = buildQuestion({ turn, attempt, maxAttempts, pos, prefix, history, rejections, allowed });
        const { letter: answer } = await ctx.ask(state, { letter: question });
        pick = pickLetter(answer, attempt > 1);
        const probs = ranked(answer), p = answer.probabilities?.[pick] ?? 1;
        const alts = probs.filter(([l]) => l !== pick).slice(0, 3).map(([l, q]) => `${l.toUpperCase()} ${pct(q)}`).join(' · ');
        section.rows.push({ prefix: `sq ${pos + 1}`, label: pick.toUpperCase(), p, strong: true,
          note: `${allowed[pos].length} options · vs ${alts}${pick !== answer.choice ? ' ↻ explored' : ''}` });
      }
      prefix += pick;
      await ctx.type(pick);
      await ctx.wait(config.letterDelayMs);
    }
    section.pending = null;
    await ctx.show([section], `Guess ${turn}, try ${attempt}: ${prefix.toUpperCase()}`);

    const chosen = section.rows.filter(r => r.strong);
    const avg = chosen.length ? chosen.reduce((s, r) => s + r.p, 0) / chosen.length : 1;
    return { word: prefix, note: `try ${attempt}, avg letter ${pct(avg)}` };
  },
};
