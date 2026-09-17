"""Jev profile: one composite Choice question per decision via Vercel AI Gateway.

Jev is an evaluation model, not a chat model: it scores typed questions against a shared state and
returns probabilities, with no reasoning text. So each decision is a single Choice question whose
options are every legal full action this turn (each move, each move + Terastallize, each switch),
and the harness shows the probability distribution instead of a "thought".

The code does the deterministic work Jev shouldn't have to reason out: legality and type effectiveness
of every option against the opposing active Pokemon are written into the option descriptions.
"""
import asyncio
import json
import os
import shutil
from pathlib import Path

from ..harness import can_tera, legal_options

BRIDGE = Path(__file__).with_name("jev_bridge.mjs")

INSTRUCTIONS = (
    "You are {me}, playing a live Gen 9 Random Battle on Pokemon Showdown against {opp}. "
    "Which single action this turn gives you the best chance to win the battle? Weigh type effectiveness, "
    "who moves first (Speed, priority), remaining HP, stat boosts, status, and whether the active Pokemon "
    "is likely to faint. Prefer strong super-effective attacks and knockouts; switch when your active "
    "Pokemon is badly threatened and a teammate handles the opponent better. Terastallize only once per "
    "game, when it wins a key exchange."
)


def mult_text(m):
    if m is None:
        return ""
    return {0: "0x (immune)", 0.25: "0.25x", 0.5: "0.5x (resisted)", 1: "1x (neutral)",
            2: "2x (super effective)", 4: "4x (super effective)"}.get(m, f"{m}x")


def build_question(state):
    req, mu = state["request"], state["matchups"]
    moves, switches = legal_options(state)
    opp = state["oppActive"]
    opp_name = opp["species"] if opp else "the opponent"
    criteria, labels = {}, {}

    if not req["forceSwitch"]:
        active = req["active"][0]
        for m in active["moves"]:
            if m["index"] not in moves:
                continue
            eff = mu["moves"].get(str(m["index"]))
            power = f"{m['basePower']} BP, " if m["basePower"] else ""
            acc = "never misses" if m["accuracy"] is True else f"{m['accuracy']}% accuracy"
            prio = f", priority {m['priority']:+d}" if m["priority"] else ""
            vs = f" Against {opp_name}: {mult_text(eff)}." if m["category"] != "Status" else ""
            desc = f"Use {m['name']}: {m['type']} {m['category'].lower()} move, {power}{acc}{prio}.{vs} {m['desc']}"
            key = f"move{m['index']}"
            criteria[key], labels[key] = desc.strip(), m["name"]
            if can_tera(state):
                tera = active["canTerastallize"]
                now = ", ".join(f"{mult_text(v)} from {t}" for t, v in mu["activeTakes"].items())
                after = ", ".join(f"{mult_text(v)} from {t}" for t, v in (mu["teraDefense"] or {}).items())
                criteria[f"{key}_tera"] = (f"Terastallize into {tera} type (once per game) and use {m['name']}.{vs} "
                                           f"Defensively vs {opp_name}'s STAB: now {now or 'unknown'}; after Tera {after or 'unknown'}.")
                labels[f"{key}_tera"] = f"{m['name']} + Tera {tera}"

    for i in switches:
        p = req["team"][i]
        hp = p["condition"].split()[0]
        cur, mx = (hp.split("/") + ["1"])[:2]
        pct = round(100 * int(cur) / int(mx)) if mx.isdigit() and int(mx) else 0
        sm = mu["switches"].get(str(i), {})
        takes = ", ".join(f"{mult_text(v)} from {t}" for t, v in sm.get("takes", {}).items())
        best = sm.get("best")
        best_txt = f" Its best attack against {opp_name}: {best['name']} ({mult_text(best['mult'])})." if best else ""
        status = f", {p['condition'].split()[1]}" if len(p["condition"].split()) > 1 else ""
        criteria[f"switch{i}"] = (f"Switch to {p['species']} ({'/'.join(p['types'])}, {pct}% HP{status}, speed {p['stats']['spe']}). "
                                  f"Takes {takes or 'unknown'} from {opp_name}'s STAB types.{best_txt}")
        labels[f"switch{i}"] = f"Switch → {p['species']}"

    return {"type": "choice", "instructions": INSTRUCTIONS.format(**state["names"]), "criteria": criteria}, labels


def build_state(state, new_log):
    req = state["request"]
    active = next((p for p in req["team"] if p["active"]), None)
    return {
        "turn": state["turn"],
        "situation": ("Your active Pokemon fainted: choose a replacement." if req["forceSwitch"]
                      else "Choose your action for this turn."),
        "recentEvents": new_log[-20:],
        "yourActive": {**(state["myActive"] or {}), **({"stats": active["stats"], "item": active["item"],
                       "ability": active["ability"], "moves": active["moves"]} if active else {})},
        "opponentActive": state["oppActive"],
        "yourActiveTakesFromOpponentStab": state["matchups"]["activeTakes"],
        "yourBench": [{"species": p["species"], "types": p["types"], "condition": p["condition"]}
                      for p in req["team"] if not p["active"]],
        "opponentRevealed": [{"species": p["species"], "hpPercent": p["hpPercent"], "fainted": p["fainted"],
                              "status": p["status"]} for p in state["oppTeamSeen"]],
        "opponentTeamSize": state["oppTeamSize"],
        "field": state["field"],
    }


class JevProfile:
    name = "jev"
    username_prefix = "JevPlays"

    def __init__(self, model="typesafe-ai/jev", timeout=60):
        self.model, self.timeout = model, timeout
        self.label = f"Jev · {model}"
        self.node = os.environ.get("NODE") or shutil.which("node") or r"C:\Program Files\nodejs\node.exe"

    def new_game(self):
        pass

    async def decide(self, state, new_log):
        question, labels = build_question(state)
        payload = {"model": self.model, "state": build_state(state, new_log), "questions": {"action": question}}
        proc = await asyncio.create_subprocess_exec(
            self.node, str(BRIDGE), stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        try:
            out, err = await asyncio.wait_for(proc.communicate(json.dumps(payload).encode("utf-8")), self.timeout)
        except asyncio.TimeoutError:
            proc.kill()
            raise RuntimeError("jev timed out")
        if proc.returncode:
            raise RuntimeError(f"jev bridge failed: {err.decode('utf-8', 'replace')[-400:]}")

        result = json.loads(out)
        answer = result["answers"]["action"]
        choice = answer["choice"]
        probs = sorted((answer.get("probabilities") or {choice: 1.0}).items(), key=lambda kv: -kv[1])

        kind = "move" if choice.startswith("move") else "switch"
        index = int(choice.removeprefix(kind).removesuffix("_tera"))
        usage = result.get("usage") or {}
        return {
            "action": kind, "index": index, "tera": choice.endswith("_tera"),
            "thought": f"{probs[0][1]:.0%} on its pick across {len(labels)} legal actions (one Choice question).",
            "bars": [[labels.get(k, k), p, k == choice] for k, p in probs[:7]],
            "choice": choice, "probabilities": dict(probs), "adjusted": bool(result.get("adjusted")),
            "metrics": {
                "input_tokens": usage.get("inputTokens"), "output_tokens": usage.get("outputTokens"),
                "cost_usd": result.get("costUsd"), "cost_source": "gateway billed",
                "api_latency_s": (result["apiMs"] / 1000) if result.get("apiMs") is not None else None,
            },
        }
