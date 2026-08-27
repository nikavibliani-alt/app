"""Unittest wrapper around scenario_tester (CI-friendly)."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from pipeline.scenario_tester import SCENARIOS  # noqa: E402


class FakeReservationScenarios(unittest.TestCase):
    def test_all_scenarios(self):
        failures = []
        for fn in SCENARIOS:
            result = fn()
            if not result.passed:
                details = "; ".join(c.detail for c in result.checks if not c.ok)
                failures.append(f"{result.name}: {details or result.error}")
        self.assertEqual(failures, [], "Failed scenarios:\n" + "\n".join(failures))


if __name__ == "__main__":
    unittest.main()
