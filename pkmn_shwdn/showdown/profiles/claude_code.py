"""Claude Code profile: one headless `claude -p` run per decision, no tools, JSON out."""
import asyncio
import json
import re
import shutil
from pathlib import Path

from ..harness import can_tera, legal_options

SYSTEM_PROMPT = """You are an expert competitive Pokemon player playing a live Gen 9 Random Battle \
on Pokemon Showdown against a live opponent. Each turn you get the full visible game \
state and the legal options. Think like a strong player: type matchups, speed tiers, likely \
random-battle sets, hazards, preserving win conditions, when to Terastallize (once per game), \
and predicting switches.

Respond with ONLY a JSON object, no markdown fences:
{"action": "move" | "switch", "index": <number from the legal options>, "tera": true|false,
 "thought": "<1-3 punchy sentences for the stream audience explaining the play>",
 "notes": "<short private memory to carry into future turns: opponent's revealed sets, plans>"}"""


def build_prompt(state, new_log, notes):
    moves, switches = legal_options(state)
    req = state["request"]
    active = req["active"][0] if req["active"] else {}
    parts = [
        f"Turn {state['turn']}. You are {state['names']['me']}, opponent is {state['names']['opp']}.",
        "\n## What happened since your last decision\n" + ("\n".join(new_log) or "(battle start)"),
        "\n## Your notes from previous turns\n" + (notes or "(none)"),
        "\n## Your active Pokemon (as shown on field)\n" + json.dumps(state["myActive"]),
        "\n## Opponent active Pokemon\n" + json.dumps(state["oppActive"]),
        f"\n## Opponent team revealed so far ({state['oppTeamSize']} total)\n" + json.dumps(state["oppTeamSeen"]),
        "\n## Your full team (exact stats/items/moves)\n" + json.dumps(req["team"]),
        "\n## Field\n" + json.dumps(state["field"]),
    ]
    if req["forceSwitch"]:
        parts.append("\n## DECISION: Your active Pokemon fainted or must switch. You MUST switch.")
    else:
        parts.append("\n## DECISION: Legal moves for your active Pokemon\n" + json.dumps(
            [m for m in active["moves"] if m["index"] in moves]))
        if can_tera(state):
            parts.append(f"You can Terastallize into {active['canTerastallize']} this turn (set tera=true with a move).")
        else:
            parts.append("Terastallization is NOT available (already used this game) - do not plan around it.")
        if active.get("trapped"):
            parts.append("You are trapped and cannot switch.")
    parts.append(f"Legal switch indices (team index): {switches or 'none'}")
    return "\n".join(parts)


class ClaudeCodeProfile:
    name = "claude-code"
    username_prefix = "ClaudeOpus"

    def __init__(self, model="claude-opus-5", effort="medium", timeout=100):
        self.model, self.effort, self.timeout = model, effort, timeout
        self.label = model.replace("claude-", "Claude ").replace("-", " ").title()
        self.exe = shutil.which("claude") or str(Path.home() / ".local/bin/claude.exe")
        self.notes = ""

    def new_game(self):
        self.notes = ""

    async def decide(self, state, new_log):
        prompt = build_prompt(state, new_log, self.notes)
        cmd = [self.exe, "-p", "--model", self.model, "--tools", "", "--effort", self.effort,
               "--no-session-persistence", "--setting-sources", "", "--output-format", "json",
               "--system-prompt", SYSTEM_PROMPT]
        proc = await asyncio.create_subprocess_exec(
            *cmd, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        try:
            out, _ = await asyncio.wait_for(proc.communicate(prompt.encode("utf-8")), self.timeout)
        except asyncio.TimeoutError:
            proc.kill()
            raise RuntimeError("model timed out")
        response = json.loads(out.decode("utf-8", "replace"))
        match = re.search(r"\{.*\}", response["result"], re.S)
        if not match:
            raise RuntimeError(f"no JSON in model output: {response['result'][:200]}")
        decision = json.loads(match.group(0))
        self.notes = decision.get("notes", self.notes)
        u = response.get("usage", {})
        cache_read, cache_write = u.get("cache_read_input_tokens", 0), u.get("cache_creation_input_tokens", 0)
        decision["metrics"] = {
            "input_tokens": u.get("input_tokens", 0) + cache_read + cache_write,
            "output_tokens": u.get("output_tokens"),
            "thinking_tokens": (u.get("output_tokens_details") or {}).get("thinking_tokens"),
            "cache_read_tokens": cache_read, "cache_write_tokens": cache_write,
            "cost_usd": response.get("total_cost_usd"), "cost_source": "Claude Code API-rate estimate",
            "api_latency_s": (response["duration_api_ms"] / 1000) if response.get("duration_api_ms") else None,
        }
        return decision
