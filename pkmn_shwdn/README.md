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
