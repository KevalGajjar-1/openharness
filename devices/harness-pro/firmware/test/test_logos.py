#!/usr/bin/env python3
"""Logo table (main/pod/engine_logos.c): sizes 28/36/44/72, every engine, the two v2 sizes within budget."""
import re
import unittest
from pathlib import Path

PRO = Path(__file__).resolve().parents[1]
C = (PRO / 'main/pod/engine_logos.c').read_text()
H = (PRO / 'main/pod/engine_logos.h').read_text()
ENGINES = "agy amp claude codex commandcode copilot cursor devin grok hermes kilo muse opencode pi".split()


class LogoTests(unittest.TestCase):
    def test_sizes(self):
        self.assertIn('POD_LOGO_NSIZES = 4', H)
        self.assertIn('pod_logo_sizes[POD_LOGO_NSIZES] = {28, 36, 44, 72}', C)

    def test_new_sizes_every_engine_and_budget(self):
        total = 0
        for e in ENGINES:
            for s in (36, 44):
                self.assertTrue(re.search(r'l_%s_%d_px\[%d\]' % (e, s, s * s), C), (e, s))
                total += s * s * 3
        print('v2 logo bytes (36 + 44, px + alpha):', total)
        self.assertLessEqual(total, 350 * 1000)


if __name__ == '__main__':
    unittest.main()
