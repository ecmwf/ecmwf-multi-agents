# SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
# SPDX-License-Identifier: Apache-2.0

# Hidden test for the feature case: `summary --json` prints the summaries as a JSON array.
# Runs from the project root, which holds the stations package and data/sample.csv.

import contextlib
import io
import json
import os
import unittest

from stations.cli import main
from stations.records import read_records
from stations.summary import daily_summaries

SAMPLE = os.path.join(os.getcwd(), "data", "sample.csv")
KEYS = {"station", "date", "min", "max", "mean", "count"}


def run(*args):
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        code = main(list(args))
    return code, out.getvalue()


class HiddenJsonTest(unittest.TestCase):
    def test_json_array(self):
        code, out = run("summary", SAMPLE, "--json")
        self.assertIn(code, (0, None))
        data = json.loads(out)
        self.assertIsInstance(data, list)
        self.assertEqual(len(data), len(daily_summaries(read_records(SAMPLE))))
        first = data[0]
        self.assertTrue(KEYS.issubset(first), f"keys: {sorted(first)}")
        self.assertEqual(first["station"], "STN-01")
        self.assertEqual(first["date"], "2026-01-01")
        self.assertEqual(first["min"], -2.5)
        self.assertEqual(first["max"], 4.0)
        self.assertEqual(first["count"], 4)

    def test_json_with_unit_and_station(self):
        code, out = run(
            "summary", SAMPLE, "--json", "--unit", "F", "--station", "STN-02"
        )
        self.assertIn(code, (0, None))
        data = json.loads(out)
        self.assertEqual({item["station"] for item in data}, {"STN-02"})
        self.assertEqual(len(data), 3)
        self.assertAlmostEqual(data[0]["min"], 50.4, places=6)
        self.assertAlmostEqual(data[0]["max"], 58.6, places=6)

    def test_table_unchanged_without_json(self):
        code, out = run("summary", SAMPLE, "--station", "STN-01", "--precision", "1")
        self.assertIn(code, (0, None))
        self.assertTrue(out.startswith("station"))
        self.assertEqual(out.splitlines()[-1], "Temperatures in degrees Celsius.")


if __name__ == "__main__":
    unittest.main()
