# Jev plays Wordle

[Jev](https://vercel.com/ai-gateway/models/jev) (`typesafe-ai/jev`, via Vercel AI Gateway) plays Wordle in a real
Chromium window driven by Playwright. Jev is a *decision* model: it doesn't write text, it answers typed questions
(here, `choice` questions) with a probability for every option. The interesting part is how you frame Wordle as
choices, so this project runs the same game three ways, called **profiles**, and compares them side by side.

## Setup

```powershell
cd wordle
npm install
npx playwright install chromium
copy .env.example .env      # then set AI_GATEWAY_API_KEY=...
npm run smoke               # 3 quick API calls to confirm the key works
```

Needs Node 20.12+. The gateway requires a credit card on the Vercel account before it serves requests.
`ffmpeg` on PATH is optional and only used to build the side-by-side videos.

## Running

| Command | What it does |
|---|---|
| `npm start` | Pick a profile and a word, then watch one game. Pauses after each guess (Enter / Space or the **Next** button in the browser; **A** switches to auto). |
| `npm run auto` | Same, playing straight through. Add `-- --profile letter-by-letter` etc. to choose the profile. |
| `npm run versus` | All three profiles on the same word at the same time, side by side, recorded. See [Versus](#versus). |
| `npm run batch -- 20 4 --profile knockout` | 20 games, 4 at a time, no visible browser; prints win rate, guesses, calls and cost. |

## How a game works

`engine.mjs` owns the game: it serves `wordle.html` (a local Wordle with the 2,315 official answers and 14,855
accepted guesses), reads the colored tiles after each guess, types, and submits. If Wordle answers **"Not in word
list"**, that's *the wall*: the row is cleared, the word is recorded as rejected, and the profile tries again (up
to its `maxAttempts` per guess). Rejected words stay in Jev's context for the whole game.

A profile only decides the next guess. Each one lives in `profiles/` with its own prompt and settings, and reports
what it's doing so the browser panel and the terminal can show Jev's options and probabilities live.

## The three profiles

All three get the same clues (every previous guess with its green / yellow / grey tiles) and use pruning where
the profile's shape allows it.

### 1. `knockout` (word knockout)

- **Jev chooses:** a whole word.
- **Pruning:** code keeps only the answers that fit every clue, and those are the options.
- **Calls per guess:** 1–2. A Choice question accepts at most 255 options, so when more words fit (e.g. all 2,315
  before the first guess) it runs a *knockout*: one call with a question per group of ≤255, then a final question
  over the group winners. Questions in one call are evaluated independently and in parallel, which suits this.
- **Prompt:** the clues, how many answers still fit, and "Which word should be guessed next? Prefer the word most
  likely to be the answer: a common, everyday English word."
- **Results:** won 20/20 random games (avg 3.9 guesses) and 8/8 in a later run (avg 4.25), about **$0.0015 per
  game**, never hitting the wall. It opens with ABOUT every game; slow games are look-alike endings
  (STATE → PLATE → CRATE → GRATE → IRATE).

### 2. `letter-by-letter`

- **Jev chooses:** one letter per call, square 1 to 5 in order, seeing the letters already typed.
- **Pruning (per square, from the tiles):** a green square is filled without asking; a yellow letter is removed from
  the square it was yellow in; a grey letter is removed from every square (only from its own square if it's a
  duplicate of a letter that is in the word). Nothing checks that the letters form a real word.
- **Calls per try:** one per open square (≤5), up to 25 tries per guess.
- **Prompt:** each option shows the word start it would create ("L: makes A E L _ _") plus its clues, and the
  instructions ask Jev to keep a specific real word in mind and only pick letters that can still finish one. Every
  rejected word is listed ("Guess 1, try 1: AERTS was rejected: not a valid 5-letter English word").
- **Results:** won 0/3. 6 of 124 typed words were accepted (4.8%), e.g. AREAS, AREDE, and ASTER → STUNK → SISTS →
  SHOTT on SMITH. About **$0.012 per game**; a game can take 5–10 minutes.

### 3. `parallel-letters`

- **Jev chooses:** all open squares at once: one call with a Choice question per square.
- **Pruning:** same per-square letter pruning as letter-by-letter.
- **Calls per try:** 1, up to 25 tries per guess.
- **Prompt:** each square is told the other squares are being chosen at the same moment by questions that can't see
  its answer, and each letter option lists the rejected words that already used it in that square.
- **Results:** won 0/3 and never got a word accepted (0 of 75). Every square independently picks its most likely
  letter, so it spells SEEEE / AEEEE / TEEEE. About **$0.005 per game**.

## Why they differ

- **Jev is built for quick, bounded judgments, not generation.** TypeSafe's docs describe each question as "a
  gut-check determination"; picking among real words is that, spelling a word one letter at a time is not.
- **Parallel questions can't coordinate.** The docs are explicit that each question in a request is evaluated on
  its own, so five squares asked together can't agree on one word.
- **Exact rule-checking belongs in code.** In a separate experiment, knockout *without* pruning (all 2,315 words
  every guess, Jev left to rule out words that contradict the clues) won 0/6, and only 1 of its 30 guesses after the
  first actually fit the clues. It drifted to look-alike words (HAUNT → TAUNT, CRATE → CRAVE → CRANE) that still
  used grey letters. Pruning is the split TypeSafe recommends: code does the deterministic filtering, Jev makes the
  judgment call among what's left.

The numbers above come from small samples (3–20 games per profile), so treat them as indicative.

## Versus

`npm run versus` plays every profile on the same secret word at once. Options: `--word crane`,
`--time-limit 12` (minutes; games still running are stopped and marked `timeout`), `--profiles a,b`,
`--headless`, `--no-video`. `node versus.mjs --rebuild runs/versus-<stamp>` remakes a run's videos and summary from
its recordings.

A stuck game can't hold up the run: each Jev call times out after 30s (retried twice), the time limit stops games
immediately, and closing a game's window ends just that game (result `closed`).

On Windows the three Chromium windows are tiled across the top of the screen, and the terminal shows a live
column per profile. Each run is saved to `runs/versus-<stamp>/`:

- `summary.md` / `summary.json`: result, accepted and rejected words, valid-word rate, Jev calls, tokens, cost, latency
- `side-by-side.mp4`: all games in one labelled video; each result appears when that game finishes
- `side-by-side-fast.mp4`: the same, switching to 4× speed about 2.5s after the first game finishes
- `<profile>.mp4` per game, and `events.jsonl` with every guess, rejection and usage update

## Files

```
wordle/
  engine.mjs          game mechanics: page, tiles, typing, the wall, pausing, in-page panel
  cli.mjs             single-game terminal UI (npm start)
  versus.mjs          all profiles side by side, recorded
  batch.mjs           headless win-rate and cost runs
  smoke.mjs           API check
  wordle.html         the local Wordle page
  answers.txt         2,315 possible answers
  guesses.txt         14,855 accepted guesses
  lib/wordle.mjs      scoring, clue text, rejected-word text, per-square letter pruning
  lib/jev.mjs         gateway model, ask() with near-tie recovery, usage, cost and latency
  lib/term.mjs        terminal styling
  profiles/           knockout, letter-by-letter, parallel-letters (+ README on writing a profile)
```

Cost estimates use the gateway list price for input tokens ($0.042 per million); output tokens aren't priced.
