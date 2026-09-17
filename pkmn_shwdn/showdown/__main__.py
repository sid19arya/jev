"""python -m showdown --profile claude-code --games 1
python -m showdown --profile claude-code --vs jev"""
import argparse
import asyncio
import sys

from .harness import run
from .profiles import PROFILES
from .versus import run_versus


def main():
    for stream in (sys.stdout, sys.stderr):  # emoji in logs on Windows consoles
        stream.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(prog="python -m showdown")
    ap.add_argument("--profile", choices=sorted(PROFILES), default="claude-code")
    ap.add_argument("--vs", choices=sorted(PROFILES), default=None,
                    help="play --profile against this profile head-to-head (two browsers, one battle)")
    ap.add_argument("--games", type=int, default=1)
    ap.add_argument("--format", default="gen9randombattle")
    ap.add_argument("--name", default=None, help="Showdown username (default: random unregistered name)")
    ap.add_argument("--headless", action="store_true")
    ap.add_argument("--model", default=None, help="model override for the profile (ignored with --vs)")
    ap.add_argument("--effort", default="medium", help="claude-code only")
    ap.add_argument("--timeout", type=int, default=100, help="seconds before falling back to a default move")
    args = ap.parse_args()

    if args.vs:
        args.model = None
        profiles = [PROFILES[args.profile](args), PROFILES[args.vs](args)]
        for _ in range(args.games):
            asyncio.run(run_versus(profiles, fmt=args.format, headless=args.headless))
        return
    profile = PROFILES[args.profile](args)
    asyncio.run(run(profile, games=args.games, fmt=args.format, name=args.name, headless=args.headless))


if __name__ == "__main__":
    main()
