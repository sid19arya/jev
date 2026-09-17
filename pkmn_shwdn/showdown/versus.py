"""Head-to-head: two profiles, two Chromium instances, one battle.

Each side logs into its own browser (recording its own point of view), side 1 challenges side 2 directly,
and both battle loops run concurrently. Afterwards: per-decision JSONL, a metrics summary (JSON + Markdown),
each side's video, and a side-by-side MP4 if ffmpeg is available.
"""
import asyncio
import datetime as dt
import json
import random
import shutil
import subprocess
from pathlib import Path

from playwright.async_api import async_playwright

from .harness import FIND_ROOM, LOGS, VIDEOS, Metrics, battle_loop, login, show


async def open_player(p, offset, headless):
    browser = await p.chromium.launch(headless=headless, args=["--window-size=1400,900", f"--window-position={offset},{offset}"])
    context = await browser.new_context(viewport={"width": 1366, "height": 768}, record_video_dir=str(VIDEOS),
                                        record_video_size={"width": 1366, "height": 768})
    return browser, context, await context.new_page()


async def start_challenge(pages, names, fmt):
    challenger, challenged = pages
    await asyncio.gather(*(show(pg, "⚔️ Versus mode", f"{names[0]} vs {names[1]} — sending challenge...") for pg in pages))
    await challenger.evaluate("([opp, fmt]) => { app.send('/utm null'); app.send('/challenge ' + opp + ', ' + fmt); }",
                              [names[1], fmt])
    for _ in range(10):  # accept once the challenge has reached the server; stop as soon as the battle exists,
        await challenged.wait_for_timeout(1500)  # or Showdown pops up "X is not challenging you" over the battle
        if await challenged.evaluate(f"!!({FIND_ROOM})"):
            break
        await challenged.evaluate("(opp) => { app.send('/utm null'); app.send('/accept ' + opp); }", names[0])
        try:
            await challenged.wait_for_function(f"!!({FIND_ROOM})", timeout=6000, polling=300)
            break
        except Exception:
            pass
    for pg in pages:
        await pg.wait_for_function(f"!!({FIND_ROOM})", timeout=30000, polling=500)
        await pg.evaluate("() => { while (app.popups && app.popups.length) app.closePopup(); }")
    room_ids = [await pg.evaluate(FIND_ROOM) for pg in pages]
    assert room_ids[0] == room_ids[1], f"players ended up in different rooms: {room_ids}"
    return room_ids[0]


def fmt_stats(s, unit="s"):
    return f"{s['mean']:.2f}{unit} / {s['median']:.2f}{unit} / {s['p95']:.2f}{unit}" if s else "—"


def markdown_summary(summary):
    sides = summary["players"]
    rows = [
        ("Model", lambda s: s["label"]),
        ("Showdown name", lambda s: s["name"]),
        ("Result", lambda s: "🏆 won" if s["won"] else "lost"),
        ("Decisions", lambda s: str(s["decisions"])),
        ("Fallback clicks (errors)", lambda s: str(s["fallbacks"])),
        ("Tokens in (total)", lambda s: f"{s['input_tokens']:,}"),
        ("  of which cache read / write", lambda s: f"{s['cache_read_tokens']:,} / {s['cache_write_tokens']:,}"),
        ("Tokens out (total)", lambda s: f"{s['output_tokens']:,}"),
        ("  of which thinking", lambda s: f"{s['thinking_tokens']:,}"),
        ("Tokens in / decision", lambda s: f"{s['input_tokens'] / max(1, s['decisions']):,.0f}"),
        ("Tokens out / decision", lambda s: f"{s['output_tokens'] / max(1, s['decisions']):,.0f}"),
        ("Cost (total)", lambda s: f"${s['cost_usd']:.4f}"),
        ("Cost / decision", lambda s: f"${s['cost_usd'] / max(1, s['decisions']):.6f}"),
        ("Cost source", lambda s: s["cost_source"] or "—"),
        ("Decision latency, wall (mean / median / p95)", lambda s: fmt_stats(s["wall_latency_s"])),
        ("Model API latency (mean / median / p95)", lambda s: fmt_stats(s["api_latency_s"])),
        ("Total thinking time", lambda s: f"{s['wall_latency_s']['total']:.0f}s" if s["wall_latency_s"] else "—"),
    ]
    out = [f"# {sides[0]['label']} vs {sides[1]['label']}", "",
           f"- Battle: {summary['battle_url']}",
           f"- Result: **{summary['result']}** after {summary['turns']} turns ({summary['duration_s'] / 60:.1f} min)", "",
           f"| Metric | {sides[0]['label']} | {sides[1]['label']} |", "|---|---|---|"]
    out += [f"| {name} | {fn(sides[0])} | {fn(sides[1])} |" for name, fn in rows]
    out += ["", "Wall latency = from the decision being requested to the answer (includes process start-up); "
            "API latency = model time reported by the provider."]
    return "\n".join(out) + "\n"


def make_videos(stamp, players):
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return []
    made = []
    for pl in players:
        mp4 = pl["video"].with_suffix(".mp4")
        subprocess.run([ffmpeg, "-loglevel", "error", "-y", "-i", str(pl["video"]), "-c:v", "libx264", "-preset",
                        "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(mp4)], check=True)
        made.append(mp4)
    both = VIDEOS / f"versus-{stamp}-side-by-side.mp4"
    subprocess.run([ffmpeg, "-loglevel", "error", "-y", "-i", str(made[0]), "-i", str(made[1]), "-filter_complex",
                    "[0:v]crop=1002:768:0:0[a];[1:v]crop=1002:768:0:0[b];[a][b]hstack=inputs=2,scale=1920:-2[v]", "-map", "[v]", "-c:v", "libx264", "-preset", "veryfast",
                    "-crf", "24", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(both)], check=True)
    return made + [both]


async def run_versus(profiles, fmt="gen9randombattle", headless=False):
    VIDEOS.mkdir(exist_ok=True)
    LOGS.mkdir(exist_ok=True)
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    names = [f"{pr.username_prefix}{random.randint(1000, 9999)}" for pr in profiles]
    metrics = [Metrics(), Metrics()]

    async with async_playwright() as p:
        opened = [await open_player(p, x, headless) for x in (0, 60)]  # cascaded so both fit small screens
        pages = [o[2] for o in opened]
        results, room_id, t0 = [None, None], None, asyncio.get_event_loop().time()
        try:
            await asyncio.gather(*(login(pg, n) for pg, n in zip(pages, names)))
            print(f"Logged in: {names[0]} ({profiles[0].label}) and {names[1]} ({profiles[1].label})", flush=True)
            room_id = await start_challenge(pages, names, fmt)
            print(f"Battle started: https://play.pokemonshowdown.com/{room_id}", flush=True)
            t0 = asyncio.get_event_loop().time()
            with open(LOGS / f"versus-{stamp}.jsonl", "a", encoding="utf-8") as log_file:
                results = await asyncio.gather(*(
                    battle_loop(pg, room_id, pr, log_file, m, player=pr.name)
                    for pg, pr, m in zip(pages, profiles, metrics)), return_exceptions=True)
            for pr, r in zip(profiles, results):
                if isinstance(r, BaseException):
                    print(f"[{pr.name}] crashed: {r!r}", flush=True)
            results = [r if isinstance(r, str) else None for r in results]
        finally:
            duration = asyncio.get_event_loop().time() - t0
            turns = 0
            if room_id:
                try:
                    turns = await pages[0].evaluate("(id) => app.rooms[id] ? app.rooms[id].battle.turn : 0", room_id)
                except Exception:
                    pass
            videos = []
            for (browser, context, page), pr in zip(opened, profiles):
                video = page.video
                await context.close()
                await browser.close()
                if video:
                    dest = VIDEOS / f"versus-{stamp}-{pr.name}.webm"
                    Path(await video.path()).rename(dest)
                    videos.append(dest)

    result = next((r for r in results if r), "no result")
    players = []
    for pr, name, m, video in zip(profiles, names, metrics, videos + [None] * (2 - len(videos))):
        players.append({"profile": pr.name, "label": pr.label, "name": name, "won": result.startswith(name + " won"),
                        "video": video, **m.summary()})
    summary = {"battle_url": f"https://play.pokemonshowdown.com/{room_id}", "format": fmt, "result": result,
               "turns": turns, "duration_s": round(duration, 1), "players": players}

    # file names only: the summary is meant to be shareable, so no absolute local paths
    shareable = {**summary, "players": [{**pl, "video": pl["video"].name if pl["video"] else None} for pl in players]}
    (LOGS / f"versus-{stamp}-summary.json").write_text(json.dumps(shareable, indent=2), encoding="utf-8")
    md = markdown_summary(summary)
    (LOGS / f"versus-{stamp}-summary.md").write_text(md, encoding="utf-8")
    print("\n" + md, flush=True)
    if len(videos) == 2:
        for path in make_videos(stamp, players):
            print(f"Video saved: {path}", flush=True)
    return summary
