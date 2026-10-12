"""
Claude AI Pricing Strategy Analyst
====================================
Runs once a week (the pricing run calls it every time; it skips itself when it already ran in the
last 7 days). Analyzes last 30 days of booking outcomes and current pricing config, then writes
strategic proposals to Firestore pricing_proposals. A new idea replaces the older PENDING idea for the
same room, season and field (the older one is closed as skipped: "Replaced by a newer idea").

Auto-applies proposals within ±5% of current value to pricing_config/rules.
Larger changes are queued for manager approval in pricing.html.
Falls back silently if ANTHROPIC_API_KEY is missing or no booking data exists.
"""

import json
import os
import sys
from collections import defaultdict
from datetime import datetime, timedelta

import anthropic

import idea_evidence

RUN_EVERY_DAYS = 7
MAKER_PROPERTIES = ["ROOMS", "MAXELA", "BIG_APT", "FREEDOM", "ORBE_1", "ORBE_2"]
REPLACED_REASON = "Replaced by a newer idea"

SYSTEM_PROMPT = """You are a revenue management analyst for Maxela Apartments in Tbilisi, Georgia.

BUSINESS CONTEXT:
- 22 units across 6 property types in central Tbilisi
- Primary guests: Arabic countries, Russia, Turkey (NOT Georgian holidays)
- Peak demand: July-August. High: May-June, September. Low: Jan-Mar, Nov-Dec
- Pricing uses startPrices (daily target), floors (minimum), ceilings (maximum)
- The pricing engine moves prices toward startPrice, adjusting for occupancy daily

YOUR TASK: Analyze the last 30 days of booking outcomes and the current config.
Identify where startPrices, floors, or ceilings should change to improve revenue.

PATTERNS TO LOOK FOR:
- Rooms consistently booked fast at ceiling → ceiling too low or startPrice should rise
- Rooms sitting empty despite low prices → startPrice or floor may be too high for season
- High avg booking price in a season → market is accepting the price, consider raising startPrice
- Very short lead time bookings (last-minute) → demand is strong, can raise startPrice
- Wide price range in bookings → floor may be unnecessarily high

RESPONSE FORMAT — return only valid JSON, no markdown fences, no text outside JSON:
{
  "proposals": [
    {
      "property": "ROOMS",
      "season": "peak",
      "type": "startPrice",
      "current": 150,
      "suggested": 165,
      "change_pct": 10.0,
      "reasoning": "80% of peak bookings hit ceiling (160) in last 30 days — startPrice can rise"
    }
  ],
  "daily_summary": "One paragraph: overall market assessment and strategy for today"
}

Valid types: startPrice, floor, ceiling, startPriceEur, floorEur, ceilingEur
Valid properties: ROOMS, MAXELA, BIG_APT, FREEDOM, ORBE_1, ORBE_2
Only propose changes where you have concrete evidence from booking data.
You have NO data about last year unless a LAST YEAR block is in the prompt. Mention last year only with numbers from that block, copied exactly. Never invent numbers or dates.
Write the reasoning as one or two plain sentences.
change_pct = (suggested - current) / current * 100 (signed: positive = increase)
Maximum ±30% change for any single proposal. Maximum 10 proposals total."""


def _get_rejection_context(db) -> str:
    """Return a summary of recently rejected proposals so Claude avoids re-proposing them."""
    try:
        cutoff = (datetime.now() - timedelta(days=60)).strftime("%Y-%m-%d")
        snaps = (
            db.collection("pricing_proposals")
            .where("status", "==", "rejected")
            .where("date", ">=", cutoff)
            .get()
        )
    except Exception:
        return ""

    groups = defaultdict(list)
    for snap in snaps:
        d = snap.to_dict()
        key = (d.get("property", ""), d.get("season", ""), d.get("type", ""))
        groups[key].append((d.get("date", ""), d.get("rejection_reason", "")))

    if not groups:
        return ""

    lines = ["\nREJECTED PROPOSALS (last 60 days — do not re-propose without new evidence):"]
    for (prop, season, ptype), rejections in sorted(groups.items()):
        count = len(rejections)
        parts = []
        for date, reason in sorted(rejections, reverse=True)[:3]:
            parts.append(f"'{reason}' ({date})" if reason else f"no reason ({date})")
        lines.append(f"  {prop} {season} {ptype}: rejected {count}x — {', '.join(parts)}")
    return "\n".join(lines)


def build_analyst_prompt(config: dict, learning_context: str, rejection_context: str = "") -> str:
    today = datetime.now().strftime("%Y-%m-%d")

    lines = [
        f"Today: {today}",
        "\nCURRENT PRICING CONFIG:",
        "startPrices (GEL — target price the engine aims for):",
    ]
    for rt, seasons in config.get("startPrices", {}).items():
        lines.append(f"  {rt}: {seasons}")

    lines.append("\nfloors (GEL — minimum allowed price, priceRules.min):")
    for rt, seasons in config.get("floor_prices_gel", {}).items():
        lines.append(f"  {rt}: {seasons}")

    lines.append("\nceilings (GEL — maximum allowed price, priceRules.max):")
    for rt, seasons in config.get("ceiling_prices_gel", {}).items():
        lines.append(f"  {rt}: {seasons}")

    if config.get("startPricesEur"):
        lines.append("\nstartPrices (EUR — for Airbnb properties):")
        for rt, seasons in config["startPricesEur"].items():
            lines.append(f"  {rt}: {seasons}")

    if config.get("floor_prices_eur"):
        lines.append("\nfloors (EUR):")
        for rt, seasons in config["floor_prices_eur"].items():
            lines.append(f"  {rt}: {seasons}")

    if config.get("ceiling_prices_eur"):
        lines.append("\nceilings (EUR):")
        for rt, seasons in config["ceiling_prices_eur"].items():
            lines.append(f"  {rt}: {seasons}")

    if learning_context:
        lines.append(learning_context)

    if rejection_context:
        lines.append(rejection_context)

    return "\n".join(lines)


def call_claude_analyst(prompt: str, api_key: str, timeout: float = 45.0) -> dict:
    client = anthropic.Anthropic(api_key=api_key, timeout=timeout)
    msg = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=2048,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": prompt}],
    )
    text = msg.content[0].text.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1].rsplit("```", 1)[0].strip()
    return json.loads(text)


def _apply_to_rules_data(rules_data: dict, prop: str, season: str, ptype: str, value):
    """Apply a proposal to the rules_data dict (Firestore format) in place."""
    if ptype == "startPrice":
        rules_data.setdefault("startPrices", {}).setdefault(prop, {})[season] = value
    elif ptype == "floor":
        rules_data.setdefault("priceRules", {}).setdefault(prop, {}).setdefault(season, {})["min"] = value
    elif ptype == "ceiling":
        rules_data.setdefault("priceRules", {}).setdefault(prop, {}).setdefault(season, {})["max"] = value
    elif ptype == "startPriceEur":
        rules_data.setdefault("startPricesEur", {}).setdefault(prop, {})[season] = value
    elif ptype == "floorEur":
        rules_data.setdefault("eurRules", {}).setdefault(prop, {}).setdefault(season, {})["min"] = value
    elif ptype == "ceilingEur":
        rules_data.setdefault("eurRules", {}).setdefault(prop, {}).setdefault(season, {})["max"] = value


def _apply_to_config(config: dict, prop: str, season: str, ptype: str, value):
    """Apply a proposal to the in-memory config dict in place."""
    if ptype == "startPrice":
        config.setdefault("startPrices", {}).setdefault(prop, {})[season] = value
    elif ptype == "floor":
        config.setdefault("floor_prices_gel", {}).setdefault(prop, {})[season] = value
    elif ptype == "ceiling":
        config.setdefault("ceiling_prices_gel", {}).setdefault(prop, {})[season] = value
    elif ptype == "startPriceEur":
        config.setdefault("startPricesEur", {}).setdefault(prop, {})[season] = value
    elif ptype == "floorEur":
        config.setdefault("floor_prices_eur", {}).setdefault(prop, {})[season] = value
    elif ptype == "ceilingEur":
        config.setdefault("ceiling_prices_eur", {}).setdefault(prop, {})[season] = value


def _tbilisi_today() -> str:
    return (datetime.utcnow() + timedelta(hours=4)).date().isoformat()


def claude_write_daily_proposal(config: dict, db, velocity: dict = None, force: bool = False) -> dict:
    """
    Weekly strategy analyst: analyzes last 30 days, writes proposals to Firestore.
    Auto-applies proposals ≤5% change to config in Firestore + in memory.
    Returns updated config dict.
    Skips if it already ran in the last 7 days or if ANTHROPIC_API_KEY is missing.
    """
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        return config

    today = datetime.now().strftime("%Y-%m-%d")

    # Weekly: skip if a run marker exists for today or any of the 6 days before (force = a manual fresh set)
    try:
        for back in range(0 if force else RUN_EVERY_DAYS):
            day = (datetime.now() - timedelta(days=back)).strftime("%Y-%m-%d")
            if db.collection("pricing_proposals").document(f"run_{day}").get().exists:
                print(f"  Claude proposals were written on {day} (runs once a week) — skipping.")
                return config
    except Exception:
        pass

    # Need booking history to make recommendations
    try:
        from price_tracker import get_learning_context
        learning_context = get_learning_context(db, days_back=30)
    except Exception as e:
        print(f"  Warning: could not load learning context: {e}", file=sys.stderr)
        learning_context = ""

    if not learning_context:
        print("  No booking history yet — skipping Claude analyst.")
        return config

    # Load rejection history so Claude avoids re-proposing recently rejected changes
    rejection_context = _get_rejection_context(db)

    # Real numbers about last year (from the stored stays), so the idea maker never has to guess them
    ev_today = _tbilisi_today()
    stays = idea_evidence.load_stays(db, ev_today)
    try:
        last_year_context = idea_evidence.last_year_lines(db, config, ev_today, MAKER_PROPERTIES, stays)
    except Exception as e:
        print(f"  Warning: could not work out last year's numbers: {e}", file=sys.stderr)
        last_year_context = ""

    # Build prompt and call Claude
    prompt = build_analyst_prompt(config, learning_context + last_year_context, rejection_context)
    try:
        response = call_claude_analyst(prompt, api_key)
    except Exception as e:
        print(f"  Claude analyst failed: {e}", file=sys.stderr)
        return config

    proposals = response.get("proposals", [])
    summary = response.get("daily_summary", "")
    print(f"  Claude analyst: {len(proposals)} proposals.")
    if summary:
        print(f"  Strategy: {summary[:120]}")

    # Read current Firestore rules for auto-apply
    try:
        rules_ref = db.collection("pricing_config").document("rules")
        rules_snap = rules_ref.get()
        rules_data = rules_snap.to_dict() if rules_snap.exists else {}
    except Exception as e:
        print(f"  Warning: could not read rules for auto-apply: {e}", file=sys.stderr)
        rules_data = {}

    auto_applied = 0
    pending_count = 0
    batch = db.batch()
    batch_count = 0
    # older pending ideas of ours, by (room, season, field): a new idea for the same key replaces them
    older_pending = {}
    try:
        for snap in db.collection("pricing_proposals").where("status", "==", "pending").stream():
            d = snap.to_dict() or {}
            if d.get("type") == "run_marker":
                continue
            older_pending.setdefault((d.get("property"), d.get("season"), d.get("type")), []).append(snap.id)
    except Exception as e:
        print(f"  Warning: could not read older pending ideas: {e}", file=sys.stderr)
    replaced = 0

    if not isinstance(proposals, list):
        proposals = []

    def _is_num(v):
        return isinstance(v, (int, float)) and not isinstance(v, bool)

    for p in proposals:
        if not isinstance(p, dict):
            continue
        prop = p.get("property")
        season = p.get("season")
        ptype = p.get("type")
        suggested = p.get("suggested")
        current_val = p.get("current")
        reasoning = p.get("reasoning", "")

        if not all([prop, season, ptype]):
            continue
        # A null or non-numeric number skips this proposal; it must never stop the run
        if not _is_num(suggested) or not _is_num(current_val):
            print(f"  Skipping proposal with a missing/non-numeric value: {prop} {season} {ptype}")
            continue

        # Compute actual change_pct ourselves to verify (don't trust Claude's math)
        if current_val != 0:
            actual_pct = (suggested - current_val) / abs(current_val) * 100
        else:
            actual_pct = 100.0

        # Auto-apply is OFF: every proposal waits for manual approval in pricing.html
        status = "pending"

        # Save proposal doc
        prop_ref = db.collection("pricing_proposals").document()
        for old_id in older_pending.pop((prop, season, ptype), []):
            batch.update(db.collection("pricing_proposals").document(old_id), {
                "status": "rejected", "rejection_reason": REPLACED_REASON, "rejected_at": datetime.now(),
                "replaced_by": prop_ref.id,
            })
            batch_count += 1
            replaced += 1
        # The facts behind the idea, saved now: real dates, booked and empty nights, last year's numbers
        try:
            evidence = idea_evidence.collect(db, config, ev_today, prop, season, ptype, reasoning, stays)
        except Exception as e:
            print(f"  Warning: no evidence saved for {prop} {season} {ptype}: {e}", file=sys.stderr)
            evidence = None
        batch.set(prop_ref, {
            **({"evidence": evidence} if evidence else {}),
            "date":       today,
            "property":   prop,
            "season":     season,
            "type":       ptype,
            "current":    current_val,
            "suggested":  suggested,
            "change_pct": round(actual_pct, 1),
            "reasoning":  reasoning,
            "status":     status,
            "ts":         datetime.now().isoformat(),
        })
        batch_count += 1

        if status == "auto_applied":
            _apply_to_rules_data(rules_data, prop, season, ptype, suggested)
            _apply_to_config(config, prop, season, ptype, suggested)
            auto_applied += 1
        else:
            pending_count += 1

        if batch_count >= 450:
            batch.commit()
            batch = db.batch()
            batch_count = 0

    # Write run marker (includes summary)
    marker_ref = db.collection("pricing_proposals").document(f"run_{today}")
    batch.set(marker_ref, {
        "date":           today,
        "type":           "run_marker",
        "summary":        summary,
        "proposal_count": len(proposals),
        "auto_applied":   auto_applied,
        "pending":        pending_count,
        "replaced":       replaced,
        "ts":             datetime.now().isoformat(),
    })

    batch.commit()

    # (auto-apply is off: the analyst never writes to pricing_config/rules)

    # Log auto-applied proposals to pricing_changes for history card
    if auto_applied:
        auto_labels = [
            f"{p.get('property')} {p.get('season')} {p.get('type')} {p.get('current')}→{p.get('suggested')}"
            for p in proposals if (
                p.get("property") and p.get("season") and p.get("type")
                and abs((p.get("suggested", 0) - p.get("current", 1)) / (p.get("current", 1) or 1) * 100) <= 5.0
            )
        ]
        try:
            db.collection("pricing_changes").add({
                "ts":     datetime.now(),
                "type":   "auto_applied",
                "detail": f"Auto-applied {auto_applied} Claude proposal(s): {', '.join(auto_labels[:5])}",
            })
        except Exception:
            pass

    if replaced:
        print(f"  {replaced} older pending idea(s) replaced by newer ones for the same room, season and field.")
    if pending_count:
        print(f"  {pending_count} proposals queued for manual approval in pricing.html.")

    return config
