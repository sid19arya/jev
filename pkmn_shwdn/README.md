# pkmn_shwdn — LLMs playing Pokémon Showdown

Plays ladder Random Battles on the real <https://play.pokemonshowdown.com> against real people.
Playwright drives a visible Chromium window and records video, and a pluggable **profile** makes each decision.

```
pip install -r requirements.txt && python -m playwright install chromium
npm install                      # only for the jev profile
python -m showdown --profile claude-code --games 1
```

Videos go to `videos/`, per-decision logs (JSONL) to `logs/`.

## How it works

```
showdown/harness.py        (owns control flow)
  Playwright → Chromium → play.pokemonshowdown.com (real client, real server)
    read  : page.evaluate(STATE_JS) → the client's parsed battle state (room.request + room.battle)
    legal : legal_options() from the server's request (PP, disabled, trapped, forced switch, tera)
    act   : validates the decision, clicks the matching button; falls back to a legal move on error
    show  : overlay panel with the profile's reasoning / probabilities
showdown/profiles/*.py     (state → decision)
```

A profile never touches the browser. It returns `{"action": "move"|"switch", "index": n, "tera": bool}`
plus optional display fields (`thought`, `bars`), and the harness only accepts legal choices,
so the model can't forfeit, chat, or click anything else.

## Profiles

### `claude-code`
One headless Claude Code run per decision:
`claude -p --model claude-opus-5 --tools "" --setting-sources "" --no-session-persistence --system-prompt ... --output-format json`.
The model has no tools, gets the state as text (recent log, team, opponent, field, legal options), and replies with
JSON: action, index, tera, a short `thought` for the overlay, and `notes`, which are fed into the next turn's prompt as memory.
Uses your Claude Code login (no API key). Options: `--model`, `--effort`, `--timeout`.

### `jev`
[Jev](https://vercel.com/ai-gateway/models/jev) (`typesafe-ai/jev`) through Vercel AI Gateway. Jev is an evaluation model:
it scores typed questions against a shared state and returns probabilities, with no reasoning text. Each decision is **one
composite Choice question**. Every legal full action this turn is an option (`move1`…`move4`, `moveN_tera`, `switchN`),
so Jev weighs attacking, Terastallizing and switching against each other in a single distribution. The harness computes
the deterministic facts and writes them into each option's description: type effectiveness vs the opposing active Pokémon,
what each switch-in takes from the opponent's STAB types, each switch-in's best attack, and the defensive change from Tera.
The overlay shows the probability bars instead of a thought.

Python calls a small Node bridge (`showdown/profiles/jev_bridge.mjs`) that uses the AI SDK's `experimental_evaluate`:

```
npm install                      # ai + @ai-sdk/gateway
echo AI_GATEWAY_API_KEY=... > .env
python -m showdown --profile jev --games 1
```

Set `NODE` if `node` isn't on PATH. No memory between turns: each call sees the current state plus the last 20 log lines.

## Versus mode

```
python -m showdown --profile claude-code --vs jev
```

Two Chromium instances, each logged in as its own guest and recording its own point of view. Side 1 challenges
side 2 directly (no ladder), and both battle loops run concurrently in one battle. Each overlay shows a running
footer of decisions, tokens in/out, cost and average latency. When the battle ends you get:

- `logs/versus-<stamp>.jsonl`: every decision from both sides, with tokens, cost and latency
- `logs/versus-<stamp>-summary.{md,json}`: per-player totals: tokens in/out (cache and thinking breakdown), cost,
  wall latency and model API latency (mean / median / p95)
- `videos/versus-<stamp>-<profile>.mp4` for each side, plus `-side-by-side.mp4` (needs ffmpeg)

Metric sources: Jev's cost is the amount the gateway billed (`providerMetadata.gateway.cost`), and its API latency is
the gateway's provider timing. Claude's tokens, cost (an API-rate estimate, not what a subscription is billed) and
API latency come from `claude -p --output-format json`. Wall latency is measured by the harness and includes
process start-up.

## Results: Claude Opus 5 vs Jev (1 game)

One head-to-head game in versus mode, Gen 9 Random Battle, recorded September 2026.
Full numbers: [`results/versus-20260917-001155-summary.json`](results/versus-20260917-001155-summary.json).

**Jev won** after 33 turns (about 11 minutes). It came down to the last Pokémon on each side: Opus's Dudunsparce
had used Calm Mind twice and got Jev's Chimecho to 26%, but it was at 10% HP and slower, and Chimecho's
Psychic Noise finished it.

| | Claude Opus 5 (`claude-code`) | Jev (`jev`) |
|---|---|---|
| Result | lost | **won** |
| Decisions | 40 | 38 |
| Fallback clicks (errors) | 0 | 0 |
| Tokens in (total / per decision) | 152,901 / 3,823 | 67,923 / 1,787 |
| Tokens out (total / per decision) | 27,488 / 687 (17,855 thinking) | 2,582 / 68 |
| Cost (total / per decision) | $2.35 / $0.059 | $0.0029 / $0.000075 |
| Decision latency, mean / median / p95 | 9.97s / 9.02s / 21.5s | 0.97s / 0.91s / 1.44s |
| Model API latency, mean / median / p95 | 9.49s / 8.37s / 21.4s | 0.24s / 0.22s / 0.47s |
| Total thinking time | 6m 39s | 37s |

How to read it:

- **One game.** Random Battles give each side a random team, so a single game says little about playing
  strength. What carries over is the cost and latency profile.
- **Cost sources differ.** Jev's cost is the amount Vercel AI Gateway billed for each call. Opus's cost is
  the `total_cost_usd` that `claude -p` reports for each call: Claude Code's own estimate at API rates, not
  what a Claude subscription is charged.
- **Opus's cost includes cache writes that never paid off.** Claude Code wrote nearly every input token
  (152,821 of 152,901) to its 1-hour prompt cache. Each decision starts a fresh session, so the cache was
  never read back. Cache writes are priced above plain input, so a direct API call without caching would
  cost less.
- **Decision latency** is measured by the harness and includes process start-up (`claude` or `node`);
  **API latency** is the model time reported by each provider.
- Opus made each decision with its reasoning in a JSON reply; Jev answered one composite Choice question
  over every legal action and returned a probability for each (see the `jev` profile above).
