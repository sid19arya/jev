// Parallel letters: one Jev call per try with five Choice questions, one per square, each choosing from A–Z.
//
// TypeSafe evaluates every question in a request independently against the same state, so each square sees
// the clues, rejected words and its own position, but not what the other squares are picking. Each question
// is told that. Non-words hit the wall like in letter-by-letter, and rejected words stay in the state all game.
//
// Kept as a reference point: independent squares can't coordinate on one word. An early probe of this setup
// spelled SEEEE (every square picked its own most likely letter).
import { historyLines, rejectionLines, describeLetterClues } from '../lib/wordle.mjs';
import { ranked } from '../lib/jev.mjs';

const config = {
  maxAttempts: 25,    // words the game may reject in one turn before giving up
  exploreTopK: 5,     // on retries, sample from each square's top K letters…
  explorePower: 2,    // …weighted by probability^power, so strong favorites still dominate
};

const ALPHABET = [...'abcdefghijklmnopqrstuvwxyz'];
const SQUARES = [0, 1, 2, 3, 4];

// One option per letter for one square: color clues, plus the rejected words that had this letter in this square.
// Without the second part each square can't tell that its own letter was part of a word the game refused.
function describeOption(letter, pos, history, rejections) {
  const L = letter.toUpperCase();
  const usedHere = rejections.filter(r => r.word[pos] === letter).map(r => r.word.toUpperCase());
  const rejectedNote = usedHere.length
    ? ` Already used in square ${pos + 1} in ${usedHere.length} rejected word${usedHere.length === 1 ? '' : 's'}: ${usedHere.join(', ')}.`
    : '';
  return `${L} in square ${pos + 1}. Clues: ${describeLetterClues(letter, pos, history)}.${rejectedNote}`;
}

function buildRequest({ turn, attempt, maxAttempts, history, rejections }) {
  const state = [
    `Game: Wordle. Guess ${turn} of 6. The hidden answer is a common 5-letter English word.`,
    'The game only accepts real 5-letter English words; anything else is rejected and must be retyped.',
    'Previous guesses (green = right letter, right square; yellow = in the word, wrong square; grey = not in the word):',
    ...historyLines(history),
    ...rejectionLines(rejections),
    `This is try ${attempt} of ${maxAttempts} for guess ${turn}.`,
    'All five letters of the guess are chosen at the same time: one question per square.',
  ].join('\n');

  const questions = Object.fromEntries(SQUARES.map(pos => [`square_${pos + 1}`, {
    type: 'choice',
    instructions:
      `Choose the letter for square ${pos + 1} of 5 in the guess. ` +
      'The other four squares are chosen at the same moment by separate questions that cannot see your answer, ' +
      `so pick the letter that square ${pos + 1} most likely has in the real English word that is the answer. ` +
      'Keep green letters in place, move yellow letters to other squares, never use grey letters, and never spell a word the game already rejected. ' +
      `Each option notes the rejected words that already used that letter in square ${pos + 1}; those letters helped spell words the game refused.`,
    criteria: Object.fromEntries(ALPHABET.map(l => [l, describeOption(l, pos, history, rejections)])),
  }]));

  return { state, questions };
}

// First try: each square's top letter. Retries: sample from each square's top letters so a rejected word doesn't repeat.
function pickLetter(answer, explore) {
  if (!explore) return answer.choice;
  const top = ranked(answer).slice(0, config.exploreTopK).map(([l, p]) => [l, p ** config.explorePower]);
  let r = Math.random() * top.reduce((sum, [, w]) => sum + w, 0);
  for (const [l, w] of top) if ((r -= w) <= 0) return l;
  return answer.choice;
}

const pct = p => `${Math.round(p * 100)}%`;
const secs = ms => `${(ms / 1000).toFixed(2)}s`;

export default {
  name: 'parallel-letters',
  title: 'Parallel letters',
  description: 'One call per try: 5 independent questions (one per square, A–Z each); invalid words hit the wall.',
  config,

  async guess(ctx) {
    const { turn, attempt, maxAttempts, history, rejections } = ctx;
    const section = { title: `Try ${attempt}/${maxAttempts} · 1 call, 5 parallel questions`, pending: 'asking all 5 squares at once…', rows: [] };
    await ctx.show([section], `Guess ${turn}, try ${attempt}: choosing all letters at once`);

    const { state, questions } = buildRequest({ turn, attempt, maxAttempts, history, rejections });
    const started = Date.now();
    const answers = await ctx.ask(state, questions);
    section.title += ` · ${secs(Date.now() - started)}`;
    section.pending = null;

    let word = '';
    for (const pos of SQUARES) {
      const answer = answers[`square_${pos + 1}`];
      const pick = pickLetter(answer, attempt > 1);
      const p = answer.probabilities?.[pick] ?? 1;
      const alts = ranked(answer).filter(([l]) => l !== pick).slice(0, 3).map(([l, q]) => `${l.toUpperCase()} ${pct(q)}`).join(' · ');
      section.rows.push({ prefix: `sq ${pos + 1}`, label: pick.toUpperCase(), p, strong: true,
        note: `vs ${alts}${pick !== answer.choice ? ' ↻ explored' : ''}` });
      word += pick;
    }
    await ctx.show([section], `Guess ${turn}, try ${attempt}: ${word.toUpperCase()}`);

    const avg = section.rows.reduce((s, r) => s + r.p, 0) / section.rows.length;
    return { word, note: `try ${attempt}, avg letter ${pct(avg)}` };
  },
};
