"""Most idea tests do not need the real engine: the effect test is replaced by 'the idea changes the sellable nights of the next stretch of
its season' (the saved daily prices decide), so those tests stay about what they test. Tests that need the real thing use
@pytest.mark.real_effect."""

import json
import os
import sys
from types import SimpleNamespace

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

import idea_effect as fx  # noqa: E402
import idea_evidence as ie  # noqa: E402


def pytest_configure(config):
    config.addinivalue_line("markers", "real_effect: use the real engine run of idea_effect.measure")


@pytest.fixture(autouse=True)
def _fake_effect(request, monkeypatch):
    if request.node.get_closest_marker("real_effect"):
        return
    config = json.load(open(os.path.join(ROOT, "config.json")))

    def build(db, repo_config, now=None):
        import claude_pricing as cp
        return SimpleNamespace(db=db, live_rts={}, today=cp._tbilisi_today())

    def measure(ctx, idea):
        sl = ie.sellable(ctx.db, config, ctx.today, idea["property"], idea["season"], idea["type"], ie.locked_nights(ctx.db))
        return {"changed": sl["nights"], "groups": fx.runs_of(sl["nights"]), "examples": [], "sellable": sl["count"], "gaps": 0,
                "price_list": ie.price_list_of(idea["type"])}
    monkeypatch.setattr(fx, "build_context", build)
    monkeypatch.setattr(fx, "measure", measure)
