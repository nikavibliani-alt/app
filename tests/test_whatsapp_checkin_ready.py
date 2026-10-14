"""Room-ready fallback (whatsapp_checkin_ready.py): which rooms get the message.

Run: python3 -m unittest tests/test_whatsapp_checkin_ready.py
"""

import os
import sys
import types
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

# The script imports these at module level; the tested function needs neither.
for _name in ('requests', 'firebase_admin'):
    if _name not in sys.modules:
        try:
            __import__(_name)
        except ImportError:
            sys.modules[_name] = types.ModuleType(_name)
if not hasattr(sys.modules['firebase_admin'], 'credentials'):
    sys.modules['firebase_admin'].credentials = types.ModuleType('firebase_admin.credentials')
    sys.modules['firebase_admin'].firestore = types.ModuleType('firebase_admin.firestore')

import whatsapp_checkin_ready as wcr  # noqa: E402


class RoomReadyExclusionTest(unittest.TestCase):
    def test_orbeliani_vgl_xcv_excluded(self):
        for code in ('orb-1', 'orb-2', 'orb-3', 'vgl-st1', 'vgl-st2', 'vgl-ap3', 'vgl-ap4',
                     'xcv-1', 'xcv-2', 'XCV-1', ' vgl-ap4 '):
            self.assertTrue(wcr.room_ready_excluded(code), code)

    def test_shartava_and_freedom_square_still_get_it(self):
        for code in ('0-1', '0-5', '6-2', '6-3', '7-4', 'tab-1', 'tab-2', 'tab-3'):
            self.assertFalse(wcr.room_ready_excluded(code), code)

    def test_empty(self):
        self.assertFalse(wcr.room_ready_excluded(''))
        self.assertFalse(wcr.room_ready_excluded(None))


if __name__ == '__main__':
    unittest.main()
