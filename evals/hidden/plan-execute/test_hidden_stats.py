# SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
# SPDX-License-Identifier: Apache-2.0

# Hidden test for the plan-execute case: per-station statistics over a whole file.
# Runs from the project root, which holds the stations package and data/sample.csv.

import os
import subprocess
import sys
import unittest

from stations.records import read_records
from stations.stats import station_statistics

SAMPLE = os.path.join(os.getcwd(), "data", "sample.csv")

# Valid readings only, in degrees Celsius: count, rejected, minimum, maximum, mean.
EXPECTED = {
    "STN-01": (7, 0, -2.5, 5.5, 10.0 / 7),
    "STN-02": (8, 1, 8.0, 14.8, 91.35 / 8),
    "STN-03": (7, 1, -15.5, -7.5, -74.25 / 7),
}


class HiddenStatsTest(unittest.TestCase):
    def test_statistics(self):
        stats = station_statistics(read_records(SAMPLE))
        self.assertEqual(set(stats), set(EXPECTED))
        for station, (count, rejected, minimum, maximum, mean) in EXPECTED.items():
            item = stats[station]
            self.assertEqual(item.count, count, station)
            self.assertEqual(item.rejected, rejected, station)
            self.assertAlmostEqual(item.minimum, minimum, delta=0.051, msg=station)
            self.assertAlmostEqual(item.maximum, maximum, delta=0.051, msg=station)
            self.assertAlmostEqual(item.mean, mean, delta=0.051, msg=station)

    def test_command(self):
        result = subprocess.run(
            [sys.executable, "-m", "stations", "stats", SAMPLE],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        for station in EXPECTED:
            self.assertIn(station, result.stdout)


if __name__ == "__main__":
    unittest.main()
