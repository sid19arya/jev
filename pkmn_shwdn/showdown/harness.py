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
  return {
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
({title, body, mood, bars}) => {
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
    ${esc(title)}</div><div>${esc(body || '')}</div>${barRows}`;
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


async def click_decision(page, room_id, decision, state):
    moves, switches = legal_options(state)
    root = f"#room-{room_id} .battle-controls"
    action, idx = decision.get("action"), decision.get("index")
    if action == "move" and idx in moves:
        if decision.get("tera") and can_tera(state):
            await page.locator(f"{root} input[name=terastallize]").check()
        await page.locator(f"{root} button[name=chooseMove][value='{idx}']").click()
        return
    if action == "switch" and idx in switches:
        await page.locator(f"{root} button[name=chooseSwitch][value='{idx}']").click()
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


async def play_game(page, profile, fmt, log_file):
    async def overlay(title, body="", mood="info", bars=None):
        await page.evaluate(OVERLAY_JS, {"title": title, "body": body, "mood": mood, "bars": bars})

    await page.evaluate("(fmt) => { app.send('/utm null'); app.send('/search ' + fmt); }", fmt)
    await overlay(f"🧠 {profile.label}", f"Searching for a {fmt} opponent on the ladder...")
    find_room = "Object.keys(app.rooms).find(id => id.startsWith('battle-') && app.rooms[id].battle && !app.rooms[id].battle.ended)"
    await page.wait_for_function(f"!!({find_room})", timeout=600000, polling=1000)
    room_id = await page.evaluate(find_room)
    print(f"Battle started: https://play.pokemonshowdown.com/{room_id}", flush=True)
    await page.evaluate("(id) => app.focusRoom(id)", room_id)
    await overlay(f"🧠 {profile.label}", "Battle found! Sizing up the opponent...")

    profile.new_game()
    last_rqid, log_cursor = None, 0
    while True:
        await page.wait_for_timeout(700)
        state = await page.evaluate(STATE_JS, room_id)
        if state is None:
            return None
        if state["ended"]:
            winner_line = next((l for l in reversed(state["logLines"]) if " won the battle" in l), "Battle over")
            await overlay(f"🏁 {profile.label}", winner_line, "decided")
            print(winner_line, flush=True)
            await page.wait_for_timeout(6000)
            return winner_line
        if not state["ready"] or not state["request"] or state["request"]["wait"] or state["rqid"] == last_rqid:
            continue

        new_log = state["logLines"][log_cursor:][-40:]
        log_cursor = len(state["logLines"])
        last_rqid = state["rqid"]
        mine = state["myActive"]["species"] if state["myActive"] else "?"
        theirs = state["oppActive"]["species"] if state["oppActive"] else "?"
        await overlay(f"🤔 {profile.label} is thinking... (turn {state['turn']})", f"{mine} vs {theirs}", "thinking")

        t0 = asyncio.get_event_loop().time()
        try:
            decision = await profile.decide(state, new_log)
            await click_decision(page, room_id, decision, state)
        except Exception as e:  # never stall the game: fall back to a legal click
            print(f"  profile/click error: {e}", file=sys.stderr, flush=True)
            decision = {**fallback_decision(state), "thought": f"(fallback — {e})"}
            await click_decision(page, room_id, decision, state)
        secs = asyncio.get_event_loop().time() - t0
        label = describe(decision, state)
        thought = decision.get("thought", "")
        await overlay(f"💡 Turn {state['turn']}: {label}  ({secs:.1f}s)", thought, "decided", decision.get("bars"))
        print(f"  T{state['turn']}: {label}" + (f" — {thought}" if thought else ""), flush=True)
        log_file.write(json.dumps({"room": room_id, "turn": state["turn"], "label": label,
                                   "decision": decision, "seconds": round(secs, 2)}) + "\n")
        log_file.flush()


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
