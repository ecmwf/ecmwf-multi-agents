# SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
# SPDX-License-Identifier: Apache-2.0

# Hidden test for the trivial-edit case: summaries round to two decimal places by default.
# Runs from the project root, which holds the stations package and data/sample.csv.

import contextlib
import io
import os
import unittest

from stations import summary
from stations.cli import main
from stations.records import read_records

SAMPLE = os.path.join(os.getcwd(), "data", "sample.csv")


class HiddenPrecisionTest(unittest.TestCase):
    def test_default_is_two_places(self):
        self.assertEqual(summary.DEFAULT_PRECISION, 2)

    def test_daily_mean_keeps_two_places(self):
        rows = summary.daily_summaries(read_records(SAMPLE))
        row = next(
            item
            for item in rows
            if item.station == "STN-02" and item.date.isoformat() == "2026-01-02"
        )
        self.assertEqual(row.mean, 11.25)

    def test_command_line_default(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = main(["summary", SAMPLE, "--station", "STN-02"])
        self.assertIn(code, (0, None))
        self.assertIn("11.25", out.getvalue())


if __name__ == "__main__":
    unittest.main()
