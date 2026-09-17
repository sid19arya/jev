"""python -m showdown --profile claude-code --games 1"""
import argparse
import asyncio

from .harness import run
from .profiles import PROFILES


def main():
    ap = argparse.ArgumentParser(prog="python -m showdown")
    ap.add_argument("--profile", choices=sorted(PROFILES), default="claude-code")
    ap.add_argument("--games", type=int, default=1)
    ap.add_argument("--format", default="gen9randombattle")
    ap.add_argument("--name", default=None, help="Showdown username (default: random unregistered name)")
    ap.add_argument("--headless", action="store_true")
    ap.add_argument("--model", default=None, help="model override for the profile")
    ap.add_argument("--effort", default="medium", help="claude-code only")
    ap.add_argument("--timeout", type=int, default=100, help="seconds before falling back to a default move")
    args = ap.parse_args()

    profile = PROFILES[args.profile](args)
    asyncio.run(run(profile, games=args.games, fmt=args.format, name=args.name, headless=args.headless))


if __name__ == "__main__":
    main()
