"""
Weekly review, Bots 2 and 3 (Claude). Bot 2 (analyst) reads ONLY the numbers from Bot 1 and writes a plain report.
Bot 3 (checker, a separate call) checks every claim against the same numbers; code then removes or marks whatever is not
supported. A claim also has to pass a mechanical check: every number written in it must exist in the data.
Nothing here changes a price or a rule: upgrades are suggestions only.
"""

from __future__ import annotations

import json
import os

import weekly_numbers as wn

MODEL = "claude-sonnet-4-6"
LISTS = ("worked", "didnt", "upgrades")
TITLES = {"worked": "What worked", "didnt": "What did not work", "upgrades": "Possible upgrades"}

ANALYST_SYSTEM = """You write the weekly pricing review for the owner of a few apartments. You are given ONE JSON with the week's numbers.
Rules:
- Use only numbers that appear in the JSON. Copy them exactly. Never add, average or estimate anything yourself.
- If the data is thin or missing (see data_notes), say that plainly instead of guessing. A zero is a fact only when the JSON says 0.
- Plain words an owner understands. No jargon, no ALL CAPS, no emojis.
- Everything is a suggestion. Never say something was changed, and never tell the engine what to do automatically.
- Every item has "refs": the dotted paths into the JSON that support it (for example rooms.MAXELA.price_up).
Reply with JSON only: {"headline": str, "worked": [{"text": str, "refs": [str]}], "didnt": [...], "upgrades": [...]}.
At most 5 items per list. An empty list is fine. Each upgrade names the numbers behind it."""

CHECKER_SYSTEM = """You check a weekly pricing report against the numbers it is based on. You are given the JSON of numbers and the report.
For every item (ids like worked.0, didnt.1, upgrades.2) and for the headline, decide:
- "yes": every claim and every number is in the data and is described correctly,
- "partly": some of it is supported; give "fixed_text" that keeps only what the data supports,
- "no": it is made up, wrong, or says something was changed automatically.
Be strict about numbers: a number that is not in the data, or a direction that is wrong, is not supported.
Reply with JSON only: {"headline": {"verdict": "yes|partly|no", "fixed_text": str}, "items": [{"id": str, "verdict": "yes|partly|no", "fixed_text": str, "note": str}]}."""


def _client(key):
    import anthropic
    return anthropic.Anthropic(api_key=key, timeout=90.0)


def _call(client, system: str, payload: str) -> dict:
    msg = client.messages.create(model=MODEL, max_tokens=4096, system=system, messages=[{"role": "user", "content": payload}])
    import claude_pricing
    return claude_pricing.parse_analyst_reply("".join(getattr(b, "text", "") for b in msg.content))


def resolve(numbers: dict, path: str):
    cur = numbers
    for part in str(path).split("."):
        if not isinstance(cur, dict) or part not in cur:
            return None
        cur = cur[part]
    return cur if cur is not None else None


def analyst(numbers: dict, key: str, client=None) -> dict:
    c = client or _client(key)
    return _call(c, ANALYST_SYSTEM, "NUMBERS:\n" + json.dumps(numbers, ensure_ascii=False, sort_keys=True))


def checker(numbers: dict, report: dict, key: str, client=None) -> dict:
    c = client or _client(key)
    return _call(c, CHECKER_SYSTEM, "NUMBERS:\n" + json.dumps(numbers, ensure_ascii=False, sort_keys=True) +
                 "\n\nREPORT:\n" + json.dumps(report, ensure_ascii=False, sort_keys=True))


def apply_check(numbers: dict, report: dict, check: dict | None) -> dict:
    """Merge Bot 3's verdicts and the mechanical check into the final report. Unsupported items are removed (and counted), partly
    supported ones are replaced by the checker's text when that text passes the number check, else removed."""
    verdicts = {i.get("id"): i for i in ((check or {}).get("items") or [])}
    out = {"headline": "", "removed": [], "edited": 0, "checked": check is not None}
    for name in LISTS:
        keep = []
        for n, it in enumerate(report.get(name) or []):
            if not isinstance(it, dict) or not it.get("text"):
                continue
            iid = f"{name}.{n}"
            v = verdicts.get(iid) or {}
            verdict = v.get("verdict") if check is not None else "no"          # no checker answer: nothing is trusted
            text, mark = it["text"], None
            bad = wn.unsupported_numbers(text, numbers)
            refs_ok = all(resolve(numbers, r) is not None or r.endswith(".0") for r in (it.get("refs") or []))
            if verdict == "partly" and v.get("fixed_text") and not wn.unsupported_numbers(v["fixed_text"], numbers):
                text, mark = v["fixed_text"], "edited"
                out["edited"] += 1
            elif verdict != "yes" or bad:
                why = "the checker could not confirm it" if verdict != "yes" else f"it uses {', '.join(bad[:3])}, which is not in the data"
                out["removed"].append({"id": iid, "text": it["text"], "why": why})
                continue
            keep.append({"text": text, "refs": [r for r in (it.get("refs") or []) if resolve(numbers, r) is not None], "edited": mark == "edited", "refs_ok": refs_ok})
        out[name] = keep
    hv = ((check or {}).get("headline") or {})
    head = report.get("headline") or ""
    if check is not None and hv.get("verdict") == "partly" and hv.get("fixed_text") and not wn.unsupported_numbers(hv["fixed_text"], numbers):
        head = hv["fixed_text"]
    elif check is None or hv.get("verdict") != "yes" or wn.unsupported_numbers(head, numbers):
        head = "The week in numbers is below. The written summary could not be confirmed against the data."
    out["headline"] = head
    return out


def review(numbers: dict, key: str, analyst_client=None, checker_client=None) -> dict:
    """Bot 2 then Bot 3. A failure of either gives a report with no written claims (the numbers are still shown)."""
    try:
        draft = analyst(numbers, key, analyst_client)
    except Exception as e:  # noqa: BLE001
        return {"headline": "The written report could not be made this week; the numbers are below.", "removed": [], "edited": 0,
                "checked": False, "error": f"analyst failed: {type(e).__name__}", **{n: [] for n in LISTS}}
    try:
        check = checker(numbers, draft, key, checker_client)
    except Exception as e:  # noqa: BLE001
        check = None
        err = f"checker failed: {type(e).__name__}"
    final = apply_check(numbers, draft, check)
    if check is None:
        final["error"] = err
    final["draft_items"] = sum(len(draft.get(n) or []) for n in LISTS)
    return final
