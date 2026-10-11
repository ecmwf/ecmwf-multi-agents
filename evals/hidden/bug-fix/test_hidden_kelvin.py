# SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
# SPDX-License-Identifier: Apache-2.0

# Hidden test for the bug-fix case: output in kelvin is correct again.
# Runs from the project root, which holds the stations package and data/sample.csv.

import contextlib
import io
import os
import unittest

from stations.cli import main
from stations.records import read_records
from stations.summary import daily_summaries
from stations.units import convert

SAMPLE = os.path.join(os.getcwd(), "data", "sample.csv")


class HiddenKelvinTest(unittest.TestCase):
    def test_convert_to_kelvin(self):
        self.assertAlmostEqual(convert(0.0, "C", "K"), 273.15)
        self.assertAlmostEqual(convert(-273.15, "C", "K"), 0.0)
        self.assertAlmostEqual(convert(32.0, "F", "K"), 273.15)

    def test_round_trip(self):
        self.assertAlmostEqual(convert(convert(12.5, "C", "K"), "K", "C"), 12.5)

    def test_summary_in_kelvin(self):
        first = daily_summaries(read_records(SAMPLE), unit="K", precision=2)[0]
        self.assertAlmostEqual(first.minimum, 270.65, delta=0.011)
        self.assertAlmostEqual(first.maximum, 277.15, delta=0.011)

    def test_command_line(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = main(["summary", SAMPLE, "--unit", "K", "--station", "STN-01"])
        self.assertIn(code, (0, None))
        self.assertNotIn("-27", out.getvalue())
        self.assertIn("277", out.getvalue())


if __name__ == "__main__":
    unittest.main()
