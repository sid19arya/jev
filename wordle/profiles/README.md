# Wordle profiles

A profile is one way of having Jev play Wordle. The engine (`../engine.mjs`) handles the game: it serves the page,
reads the colored tiles, types, submits, clears rejected words ("the wall"), pauses between turns, and renders
the in-page panel. A profile only decides the next guess.

| Profile | How Jev plays | Calls per guess | Notes |
|---|---|---|---|
| `knockout` (default) | Code filters answers that fit every clue; Jev picks one word. If >255 fit, one call with a Choice question per group of ≤255, then a final. | 1–2 | Won 20/20 in testing, ~3.9 guesses, ~$0.0015/game. |
| `letter-by-letter` | Jev picks each letter from A–Z, one call per square. No filtering, so non-words hit the wall and it retries. | 5 per try | Reference point: rarely spells a real word. 25 tries per guess; rejected words stay in its context all game. |
| `parallel-letters` | One call per try with 5 Choice questions, one per square (A–Z each). Questions are evaluated independently, so squares can't see each other's picks. Non-words hit the wall. | 1 per try | Reference point for independent parallel questions composing one answer. |

## Running

```powershell
npm start                                    # choose a profile at the prompt
npm start -- --profile letter-by-letter      # or pass it directly
npm run batch -- 20 4 --profile knockout     # 20 games, 4 at a time
```

## Writing a profile

Create `profiles/<name>.mjs` and add it to `profiles/index.mjs`:

```js
export default {
  name: 'my-profile',                 // used with --profile
  title: 'My profile',                // shown in the panel and CLI
  description: 'One line for the profile picker.',
  config: { maxAttempts: 10 },        // maxAttempts = words the game may reject in one turn before giving up

  async guess(ctx) {
    // ctx.turn, ctx.attempt          1-based guess number and try within this guess
    // ctx.history                    scored rows: [[{ letter, state: 'correct' | 'present' | 'absent' }, ×5], …]
    // ctx.candidates                 answers that fit every clue so far (code-filtered)
    // ctx.rejections, ctx.rejected   words the game rejected so far this game ([{ turn, attempt, word }] / plain words)
    // ctx.maxAttempts                tries allowed per guess
    // ctx.ask(state, questions)      Jev call → answers map (usage and cost are tracked)
    // ctx.show(sections, status)     describe progress; rendered in the browser panel and the CLI
    // ctx.type(letter)               optional: type as you go; otherwise the engine types the returned word
    // ctx.wait(ms)
    return { word: 'crane', note: 'shown next to the guess in the feedback list' }; // or null to give up
  },
};
```

A section is `{ title, pending?, rows?: [{ prefix?, label, p, strong?, note? }], columns?: 1 | 2, more? }`.
Shared helpers live in `../lib/wordle.mjs` (word list, scoring, `historyLines`) and `../lib/jev.mjs` (`ranked`).
