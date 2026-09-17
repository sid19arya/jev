// Wordle rules and word lists, shared by the engine and every profile.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const readWords = file => fs.readFileSync(path.join(ROOT, file), 'utf8').split(/\s+/).filter(w => w.length === 5);
/** Possible answers (2,315). */
export const WORDS = readWords('answers.txt');

export const COLOR = { correct: 'green', present: 'yellow', absent: 'grey' };

/** Colors for `guess` against `answer` (handles duplicate letters). Same rules as wordle.html. */
export function score(guess, answer) {
  const res = Array(5).fill('absent'), left = {};
  for (let i = 0; i < 5; i++) guess[i] === answer[i] ? res[i] = 'correct' : left[answer[i]] = (left[answer[i]] || 0) + 1;
  for (let i = 0; i < 5; i++) if (res[i] !== 'correct' && left[guess[i]] > 0) { res[i] = 'present'; left[guess[i]]--; }
  return res;
}

/** Answers that fit every scored row. `history` is [[{ letter, state }, ×5], …]. */
export const consistent = history => WORDS.filter(w => history.every(row =>
  score(row.map(t => t.letter).join(''), w).join() === row.map(t => t.state).join()));

/**
 * Words the game rejected earlier in this game, one explicit line each. `rejections` is [{ turn, attempt, word }].
 * A non-word stays a non-word, so these persist across guesses.
 */
export const rejectionLines = rejections => rejections.length
  ? ['Words the game already rejected (never guess these again):',
     ...rejections.map(r => `  Guess ${r.turn}, try ${r.attempt}: ${r.word.toUpperCase()} was rejected: not a valid 5-letter English word.`)]
  : [];

/** Previous guesses as prompt lines, e.g. "  1. CRANE: C=grey R=green A=grey N=yellow E=grey". */
export const historyLines = history => history.length
  ? history.map((row, i) => `  ${i + 1}. ${row.map(t => t.letter.toUpperCase()).join('')}: ${row.map(t => `${t.letter.toUpperCase()}=${COLOR[t.state]}`).join(' ')}`)
  : ['  none yet'];

/** What the colored tiles say about `letter` for square `pos` (0-based), in plain English. */
export function describeLetterClues(letter, pos, history) {
  const green = new Set(), yellowNotAt = new Set();
  let grey = false;
  for (const row of history) row.forEach((t, i) => {
    if (t.letter !== letter) return;
    if (t.state === 'correct') green.add(i);
    else if (t.state === 'present') yellowNotAt.add(i);
    else grey = true;
  });
  const sq = s => [...s].map(i => i + 1).join(', ');
  if (green.has(pos)) return `green in square ${pos + 1}: it belongs here`;
  if (grey && !green.size && !yellowNotAt.size) return 'was grey: it is not in the word';
  const notes = [];
  if (green.size) notes.push(`green in square ${sq(green)}`);
  if (yellowNotAt.has(pos)) notes.push(`yellow in square ${pos + 1}, so it is in the word but NOT in this square`);
  else if (yellowNotAt.size) notes.push(`yellow in square ${sq(yellowNotAt)}, so it is in the word somewhere else`);
  if (grey) notes.push('also grey once, so the word has no extra copies of it');
  return notes.length ? notes.join('; ') : 'no color clues yet';
}

/**
 * Letters still possible in each square, from the colored tiles alone: [[...letters for square 1], …×5].
 *   green in square N  → square N can only be that letter
 *   yellow in square N → that letter is removed from square N
 *   grey in square N   → removed from square N; removed everywhere only if the letter was never green or yellow
 *                        (a grey duplicate, e.g. the second E in SPEED, only means there's no extra copy)
 */
export function allowedLetters(history) {
  const alphabet = [...'abcdefghijklmnopqrstuvwxyz'];
  const present = new Set(history.flatMap(row => row.filter(t => t.state !== 'absent').map(t => t.letter)));
  const squares = Array.from({ length: 5 }, () => new Set(alphabet));
  for (const row of history) row.forEach((t, i) => {
    if (t.state === 'correct') squares[i] = new Set([t.letter]);
    else if (squares[i].size > 1) {
      squares[i].delete(t.letter);
      if (t.state === 'absent' && !present.has(t.letter)) for (const s of squares) if (s.size > 1) s.delete(t.letter);
    }
  });
  return squares.map(s => [...s]);
}
