// Plays N random games without a visible browser and reports win rate, guesses, Jev calls and cost.
// Usage: node batch.mjs [games=20] [concurrency=4] [--profile knockout]
import { playGame } from './engine.mjs';
import { WORDS } from './lib/wordle.mjs';
import { DEFAULT_PROFILE, getProfile } from './profiles/index.mjs';

const args = process.argv.slice(2);
const profileIdx = args.indexOf('--profile');
const profile = getProfile(profileIdx >= 0 ? args[profileIdx + 1] : DEFAULT_PROFILE);
const [N = 20, CONCURRENCY = 4] = args.filter((a, i) => !a.startsWith('--') && !(profileIdx >= 0 && i === profileIdx + 1)).map(Number);

console.log(`profile: ${profile.name} · ${N} games · ${CONCURRENCY} at a time\n`);
const words = Array.from({ length: N }, () => WORDS[Math.floor(Math.random() * WORDS.length)]);
const results = [];
let next = 0;
async function worker() {
  while (next < words.length) {
    const word = words[next++];
    const guesses = [];
    let walls = 0;
    try {
      const r = await playGame({ profile: profile.name, word, headless: true, video: false, onEvent: e => {
        if (e.type === 'feedback') guesses.push(e.guess.toUpperCase());
        if (e.type === 'rejected') walls++;
      } });
      results.push({ ...r, walls });
      console.log(`${r.result.padEnd(5)} ${word.toUpperCase()}  ${guesses.join(' → ') || '(no accepted guess)'}  ` +
        `(${r.calls} calls${walls ? `, ${walls} rejected` : ''}${r.unmeteredCalls ? `, ${r.unmeteredCalls} unmetered` : ''}, $${r.cost.toFixed(4)})`);
    } catch (err) {
      results.push({ result: 'error', secret: word });
      console.log(`error ${word.toUpperCase()}  ${err?.data?.error?.message ?? err.message}`);
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
const won = results.filter(r => r.result === 'won');
const sum = k => results.reduce((s, r) => s + (r[k] ?? 0), 0);
const dist = [1, 2, 3, 4, 5, 6].map(n => `${n}:${won.filter(r => r.turns === n).length}`).join(' ');
console.log(`\nwon ${won.length}/${results.length} · avg guesses (wins) ${(won.reduce((s, r) => s + r.turns, 0) / (won.length || 1)).toFixed(2)} · distribution ${dist}`);
console.log(`total: ${sum('calls')} Jev calls · ${sum('walls')} rejected words · ${sum('inputTokens').toLocaleString()} input tokens · $${sum('cost').toFixed(4)} · per game $${(sum('cost') / results.length).toFixed(4)}`);
