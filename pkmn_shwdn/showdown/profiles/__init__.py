"""Decision profiles. Each exposes: name, label, username_prefix, new_game(), async decide(state, new_log).

decide() returns {"action": "move"|"switch", "index": int, "tera": bool} plus optional display fields:
"thought" (text shown on screen) and "bars" ([label, probability, chosen] rows).
"""
from .claude_code import ClaudeCodeProfile
from .jev import JevProfile

PROFILES = {
    "claude-code": lambda a: ClaudeCodeProfile(model=a.model or "claude-opus-5", effort=a.effort, timeout=a.timeout),
    "jev": lambda a: JevProfile(model=a.model or "typesafe-ai/jev", timeout=min(a.timeout, 60)),
}
