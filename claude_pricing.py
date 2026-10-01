"""
Claude AI Pricing Strategy Analyst
====================================
Runs once per day. Analyzes last 30 days of booking outcomes and current
pricing config, then writes strategic proposals to Firestore pricing_proposals.

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


def claude_write_daily_proposal(config: dict, db, velocity: dict = None) -> dict:
    """
    Daily strategy analyst: analyzes last 30 days, writes proposals to Firestore.
    Auto-applies proposals ≤5% change to config in Firestore + in memory.
    Returns updated config dict.
    Skips if already ran today or if ANTHROPIC_API_KEY is missing.
    """
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        return config

    today = datetime.now().strftime("%Y-%m-%d")

    # Dedup: skip if already ran today
    try:
        run_marker = db.collection("pricing_proposals").document(f"run_{today}").get()
        if run_marker.exists:
            print("  Claude proposals already written today — skipping.")
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

    # Build prompt and call Claude
    prompt = build_analyst_prompt(config, learning_context, rejection_context)
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

    for p in proposals:
        prop = p.get("property")
        season = p.get("season")
        ptype = p.get("type")
        suggested = p.get("suggested")
        current_val = p.get("current")
        reasoning = p.get("reasoning", "")

        if not all([prop, season, ptype, suggested is not None]):
            continue

        # Compute actual change_pct ourselves to verify (don't trust Claude's math)
        if current_val and current_val != 0:
            actual_pct = (suggested - current_val) / abs(current_val) * 100
        else:
            actual_pct = p.get("change_pct", 100.0)

        status = "auto_applied" if abs(actual_pct) <= 5.0 else "pending"

        # Save proposal doc
        prop_ref = db.collection("pricing_proposals").document()
        batch.set(prop_ref, {
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
        "ts":             datetime.now().isoformat(),
    })

    batch.commit()

    # Persist auto-applied changes back to pricing_config/rules
    if auto_applied and rules_data:
        try:
            rules_ref.set(rules_data, merge=True)
            print(f"  Auto-applied {auto_applied} proposals (≤5% change) to pricing_config/rules.")
        except Exception as e:
            print(f"  Warning: could not write auto-applied rules: {e}", file=sys.stderr)

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

    if pending_count:
        print(f"  {pending_count} proposals queued for manual approval in pricing.html.")

    return config
