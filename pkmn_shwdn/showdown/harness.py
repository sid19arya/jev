"""Profile-agnostic harness: drives the real play.pokemonshowdown.com client with Playwright.

The harness owns the control flow: logging in, finding a battle, reading the state out of the
Showdown client, working out the legal options, clicking, the on-screen overlay and video. A profile
(see showdown/profiles) only turns a state into a decision.
"""
import asyncio
import datetime as dt
import json
import random
import sys
from pathlib import Path

from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parent.parent
VIDEOS = ROOT / "videos"
LOGS = ROOT / "logs"

# Pulls everything a profile needs out of the Showdown client's in-memory battle state.
STATE_JS = r"""
(roomId) => {
  const room = app.rooms[roomId];
  if (!room || !room.battle) return null;
  const b = room.battle, req = room.request;
  const types = (p) => {
    if (p.terastallized) return [p.terastallized];
    try { return Dex.species.get(p.speciesForme).types; } catch (e) { return []; }
  };
  const baseStats = (name) => { try { return Dex.species.get(name).baseStats; } catch (e) { return null; } };
  const moveInfo = (id) => {
    const m = Dex.moves.get(id);
    return {name: m.name, type: m.type, category: m.category, basePower: m.basePower,
            accuracy: m.accuracy, priority: m.priority, desc: m.shortDesc || m.desc || ''};
  };
  const mon = (p) => p && ({
    species: p.speciesForme, level: p.level, hpPercent: p.maxhp ? Math.round(100 * p.hp / p.maxhp) : null,
    fainted: !!p.fainted, status: p.status || '', types: types(p), terastallized: p.terastallized || '',
    boosts: p.boosts, volatiles: Object.keys(p.volatiles || {}),
    item: p.item || '(unknown)', ability: p.ability || p.baseAbility || '(unknown)',
    revealedMoves: (p.moveTrack || []).map(m => m[0]), baseStats: baseStats(p.speciesForme),
  });
  const lines = [...room.$el[0].querySelectorAll('.battle-log .inner > *')]
    .map(e => e.textContent.trim()).filter(Boolean);
  const controls = room.$el[0].querySelector('.battle-controls');

  // Type-effectiveness multipliers vs the opposing active Pokemon, from the client's own type chart.
  const chart = window.BattleTypeChart || {};
  const eff = (atk, defTypes) => defTypes.reduce((m, t) => {
    const d = (chart[t.toLowerCase()] || chart[t] || {}).damageTaken || {};
    return m * ({0: 1, 1: 2, 2: 0.5, 3: 0}[d[atk]] ?? 1);
  }, 1);
  const oppP = b.farSide.active[0], oppTypes = oppP ? types(oppP) : [];
  const matchups = {oppTypes, moves: {}, teraDefense: null, activeTakes: {}, switches: {}};
  if (req && oppP) {
    const act = (req.active || [])[0];
    if (act) act.moves.forEach((m, i) => {
      const mv = Dex.moves.get(m.id);
      matchups.moves[i + 1] = mv.category === 'Status' ? null : eff(mv.type, oppTypes);
    });
    const takes = (defTypes) => Object.fromEntries(oppTypes.map(t => [t, eff(t, defTypes)]));
    const me = b.mySide.active[0];
    if (me) matchups.activeTakes = takes(types(me));
    if (act && act.canTerastallize) matchups.teraDefense = takes([act.canTerastallize]);
    req.side.pokemon.forEach((p, i) => {
      if (p.active) return;
      let memberTypes = [];
      try { memberTypes = Dex.species.get(p.details.split(',')[0]).types; } catch (e) {}
      let best = null;
      p.moves.forEach(id => {
        const mv = Dex.moves.get(id);
        if (mv.category === 'Status' || !mv.basePower) return;
        const mult = eff(mv.type, oppTypes);
        if (!best || mult * mv.basePower > best.mult * best.bp) best = {name: mv.name, mult, bp: mv.basePower};
      });
      matchups.switches[i] = {takes: takes(memberTypes), best};
    });
  }

  return {
    matchups,
    turn: b.turn, ended: !!b.ended, rqid: req && req.rqid,
    ready: !!(controls && controls.querySelector(
      'button[name=chooseMove]:not([disabled]), button[name=chooseSwitch]:not(.disabled):not([disabled])')),
    request: req && {
      forceSwitch: req.forceSwitch || null, wait: !!req.wait,
      active: (req.active || []).map(a => ({
        canTerastallize: a.canTerastallize || null, trapped: !!a.trapped,
        moves: a.moves.map((m, i) => ({index: i + 1, pp: m.pp, maxpp: m.maxpp, disabled: !!m.disabled, ...moveInfo(m.id)})),
      })),
      team: req.side.pokemon.map((p, i) => ({
        index: i, species: p.speciesForme || p.details.split(',')[0], active: p.active, condition: p.condition,
        item: p.item, ability: p.ability, teraType: p.teraType, stats: p.stats,
        types: (() => { try { return Dex.species.get(p.details.split(',')[0]).types; } catch (e) { return []; } })(),
        moves: p.moves.map(id => { const m = Dex.moves.get(id); return `${m.name} (${m.type}, ${m.category}, BP ${m.basePower})`; }),
      })),
    },
    myActive: mon(b.mySide.active[0]),
    oppActive: mon(b.farSide.active[0]),
    oppTeamSeen: b.farSide.pokemon.map(mon),
    oppTeamSize: b.farSide.totalPokemon,
    field: {weather: b.weather || 'none', pseudoWeather: (b.pseudoWeather || []).map(w => w[0]),
            mySideConditions: Object.keys(b.mySide.sideConditions || {}),
            oppSideConditions: Object.keys(b.farSide.sideConditions || {})},
    names: {me: b.mySide.name, opp: b.farSide.name},
    logLines: lines,
  };
}
"""

OVERLAY_JS = r"""
({title, body, mood, bars, footer}) => {
  let el = document.getElementById('llm-overlay');
  if (!el) {
    el = document.createElement('div');
    el.id = 'llm-overlay';
    el.style.cssText = `position:fixed; left:14px; top:478px; width:600px; z-index:99999;
      background:rgba(20,22,35,.93); color:#f1f1f6; border-radius:12px; padding:14px 16px;
      font:16px/1.5 system-ui,Segoe UI,sans-serif; box-shadow:0 8px 30px rgba(0,0,0,.45);
      border:2px solid #d97757; pointer-events:none;`;
    document.body.appendChild(el);
  }
  const color = {thinking: '#f2c14e', decided: '#7bd88f', info: '#d97757'}[mood] || '#d97757';
  el.style.borderColor = color;
  const esc = s => String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
  const barRows = (bars || []).map(([label, p, chosen]) => `
    <div style="display:flex;align-items:center;gap:8px;margin:2px 0;font-size:14px;${chosen ? 'color:#7bd88f;font-weight:700' : ''}">
      <span style="width:250px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(label)}</span>
      <span style="flex:1;background:#333;height:9px;border-radius:4px;overflow:hidden">
        <span style="display:block;height:100%;width:${(p * 100).toFixed(1)}%;background:${chosen ? '#7bd88f' : '#8a8a9e'}"></span></span>
      <span style="width:42px;text-align:right">${Math.round(p * 100)}%</span></div>`).join('');
  el.innerHTML = `<div style="font-weight:700;color:${color};margin-bottom:6px;font-size:13px;letter-spacing:.3px">
    ${esc(title)}</div><div>${esc(body || '')}</div>${barRows}
    ${footer ? `<div style="margin-top:8px;padding-top:6px;border-top:1px solid #3a3a4a;color:#a9a9bd;font:12px ui-monospace,Consolas,monospace">${esc(footer)}</div>` : ''}`;
}
"""


def legal_options(state):
    """Returns (moves, switches) as lists of 1-based move indices / team indices."""
    req = state["request"]
    switches = [p["index"] for p in req["team"]
                if not p["active"] and not p["condition"].endswith(" fnt")]
    if req["forceSwitch"]:
        return [], switches
    active = req["active"][0]
    moves = [m["index"] for m in active["moves"] if not m["disabled"] and m["pp"] != 0]
    if active["trapped"]:
        switches = []
    return moves or [1], switches


def can_tera(state):
    req = state["request"]
    return bool(not req["forceSwitch"] and req["active"] and req["active"][0].get("canTerastallize"))


def describe(decision, state):
    req = state["request"]
    if decision["action"] == "move":
        name = next(m["name"] for m in req["active"][0]["moves"] if m["index"] == decision["index"])
        return name + (" + Terastallize" if decision.get("tera") and can_tera(state) else "")
    return f"Switch to {req['team'][decision['index']]['species']}"


async def press(page, selector):
    """Clicks like a user; if something (a popup, a tooltip) intercepts the click, triggers the button directly."""
    try:
        await page.locator(selector).click(timeout=4000)
    except Exception:
        clicked = await page.evaluate("(sel) => { const el = document.querySelector(sel); if (el) el.click(); return !!el; }",
                                      selector)
        if not clicked:
            raise


async def click_decision(page, room_id, decision, state):
    moves, switches = legal_options(state)
    root = f"#room-{room_id} .battle-controls"
    action, idx = decision.get("action"), decision.get("index")
    # Showdown popups (challenge dialogs, notices) sit over the page and swallow clicks.
    await page.evaluate("() => { while (window.app && app.popups && app.popups.length) app.closePopup(); }")
    if action == "move" and idx in moves:
        if decision.get("tera") and can_tera(state):
            tera = page.locator(f"{root} input[name=terastallize]")
            if not await tera.is_checked():
                await press(page, f"{root} input[name=terastallize]")
        await press(page, f"{root} button[name=chooseMove][value='{idx}']")
        return
    if action == "switch" and idx in switches:
        await press(page, f"{root} button[name=chooseSwitch][value='{idx}']")
        return
    raise ValueError(f"illegal decision {decision}")


def fallback_decision(state):
    moves, switches = legal_options(state)
    if moves:
        return {"action": "move", "index": moves[0], "tera": False}
    return {"action": "switch", "index": random.choice(switches), "tera": False}


async def login(page, name):
    await page.goto("https://play.pokemonshowdown.com/", wait_until="domcontentloaded")
    await page.wait_for_function("typeof app !== 'undefined' && app.user && app.socket", timeout=60000)
    await page.wait_for_timeout(2500)
    await page.click('button[name="login"]')
    await page.fill('input[name="username"]', name)
    await page.keyboard.press("Enter")
    await page.wait_for_function(f"app.user.get('named') && app.user.get('name') === {json.dumps(name)}", timeout=30000)


class Metrics:
    """Per-player running totals of latency, tokens and cost."""

    def __init__(self):
        self.records = []

    def add(self, wall_s, metrics):
        self.records.append({"wall_latency_s": wall_s, **(metrics or {})})

    def total(self, key):
        return sum(r.get(key) or 0 for r in self.records)

    def footer(self):
        n = len(self.records)
        if not n:
            return ""
        return (f"Σ {n} decisions · {self.total('input_tokens') / 1000:.1f}k tok in / {self.total('output_tokens') / 1000:.1f}k out"
                f" · ${self.total('cost_usd'):.4f} · avg {self.total('wall_latency_s') / n:.1f}s")

    def summary(self):
        def stats(key):
            vals = sorted(r[key] for r in self.records if r.get(key) is not None)
            if not vals:
                return None
            pick = lambda q: vals[min(len(vals) - 1, int(q * len(vals)))]
            return {"mean": round(sum(vals) / len(vals), 3), "median": round(pick(0.5), 3),
                    "p95": round(pick(0.95), 3), "max": round(vals[-1], 3), "total": round(sum(vals), 3)}
        return {
            "decisions": len(self.records),
            "fallbacks": sum(1 for r in self.records if r.get("fallback")),
            "input_tokens": self.total("input_tokens"), "output_tokens": self.total("output_tokens"),
            "thinking_tokens": self.total("thinking_tokens"),
            "cache_read_tokens": self.total("cache_read_tokens"), "cache_write_tokens": self.total("cache_write_tokens"),
            "cost_usd": round(self.total("cost_usd"), 6),
            "cost_source": next((r["cost_source"] for r in self.records if r.get("cost_source")), None),
            "wall_latency_s": stats("wall_latency_s"), "api_latency_s": stats("api_latency_s"),
        }


async def show(page, title, body="", mood="info", bars=None, footer=""):
    await page.evaluate(OVERLAY_JS, {"title": title, "body": body, "mood": mood, "bars": bars, "footer": footer})


FIND_ROOM = ("Object.keys(app.rooms).find(id => id.startsWith('battle-') && app.rooms[id].battle "
             "&& !app.rooms[id].battle.ended)")


async def battle_loop(page, room_id, profile, log_file, metrics=None, player=None):
    """Plays one battle to the end in an already-open battle room. Returns the winner line."""
    metrics = metrics or Metrics()
    tag = f"[{player}] " if player else ""
    await page.evaluate("(id) => app.focusRoom(id)", room_id)
    await show(page, f"🧠 {profile.label}", "Battle found! Sizing up the opponent...")
    profile.new_game()
    last_rqid, log_cursor = None, 0
    while True:
        await page.wait_for_timeout(700)
        state = await page.evaluate(STATE_JS, room_id)
        if state is None:
            return None
        if state["ended"]:
            winner_line = next((l for l in reversed(state["logLines"]) if " won the battle" in l), "Battle over")
            await show(page, f"🏁 {profile.label}", winner_line, "decided", footer=metrics.footer())
            print(f"{tag}{winner_line}", flush=True)
            await page.wait_for_timeout(6000)
            return winner_line
        if not state["ready"] or not state["request"] or state["request"]["wait"] or state["rqid"] == last_rqid:
            continue

        new_log = state["logLines"][log_cursor:][-40:]
        log_cursor = len(state["logLines"])
        last_rqid = state["rqid"]
        mine = state["myActive"]["species"] if state["myActive"] else "?"
        theirs = state["oppActive"]["species"] if state["oppActive"] else "?"
        await show(page, f"🤔 {profile.label} is thinking... (turn {state['turn']})", f"{mine} vs {theirs}", "thinking",
                   footer=metrics.footer())

        t0 = asyncio.get_event_loop().time()
        try:
            decision = await profile.decide(state, new_log)
            wall = asyncio.get_event_loop().time() - t0
            await click_decision(page, room_id, decision, state)
        except Exception as e:  # never stall the game: fall back to a legal click
            wall = asyncio.get_event_loop().time() - t0
            print(f"{tag}  profile/click error: {e}", file=sys.stderr, flush=True)
            decision = {**fallback_decision(state), "thought": f"(fallback — {e})", "metrics": {"fallback": True}}
            await click_decision(page, room_id, decision, state)
        metrics.add(wall, decision.get("metrics"))
        label = describe(decision, state)
        thought = decision.get("thought", "")
        await show(page, f"💡 Turn {state['turn']}: {label}  ({wall:.1f}s)", thought, "decided", decision.get("bars"),
                   footer=metrics.footer())
        print(f"{tag}  T{state['turn']}: {label} ({wall:.1f}s)" + (f" — {thought}" if thought else ""), flush=True)
        log_file.write(json.dumps({"player": player or profile.name, "room": room_id, "turn": state["turn"],
                                   "label": label, "wall_latency_s": round(wall, 3), "decision": decision}) + "\n")
        log_file.flush()


async def play_game(page, profile, fmt, log_file):
    """Searches the ladder for an opponent, then plays the battle."""
    await page.evaluate("(fmt) => { app.send('/utm null'); app.send('/search ' + fmt); }", fmt)
    await show(page, f"🧠 {profile.label}", f"Searching for a {fmt} opponent on the ladder...")
    await page.wait_for_function(f"!!({FIND_ROOM})", timeout=600000, polling=1000)
    room_id = await page.evaluate(FIND_ROOM)
    print(f"Battle started: https://play.pokemonshowdown.com/{room_id}", flush=True)
    return await battle_loop(page, room_id, profile, log_file)


async def run(profile, games=1, fmt="gen9randombattle", name=None, headless=False):
    VIDEOS.mkdir(exist_ok=True)
    LOGS.mkdir(exist_ok=True)
    name = name or f"{profile.username_prefix}{random.randint(1000, 9999)}"
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    tag = f"{profile.name}-{stamp}"

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=headless, args=["--window-size=1400,900"])
        context = await browser.new_context(viewport={"width": 1366, "height": 768},
                                            record_video_dir=str(VIDEOS),
                                            record_video_size={"width": 1366, "height": 768})
        page = await context.new_page()
        try:
            await login(page, name)
            print(f"Logged in as {name} ({profile.label})", flush=True)
            with open(LOGS / f"{tag}.jsonl", "a", encoding="utf-8") as log_file:
                for g in range(games):
                    result = await play_game(page, profile, fmt, log_file)
                    log_file.write(json.dumps({"game": g + 1, "result": result}) + "\n")
                    await page.evaluate("() => Object.keys(app.rooms).filter(id => id.startsWith('battle-'))"
                                        ".forEach(id => app.leaveRoom(id))")
        finally:
            video = page.video
            await context.close()
            await browser.close()
            if video:
                dest = VIDEOS / f"{tag}.webm"
                Path(await video.path()).rename(dest)
                print(f"Video saved: {dest}", flush=True)
