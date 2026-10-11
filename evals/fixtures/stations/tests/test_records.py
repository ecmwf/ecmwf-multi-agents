# SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
# SPDX-License-Identifier: Apache-2.0

import os
import tempfile
import unittest
from datetime import date

from stations.records import parse_temperature, parse_time, read_records, station_ids

SAMPLE = os.path.join(os.path.dirname(__file__), "..", "data", "sample.csv")


class RecordsTest(unittest.TestCase):
    def test_parse_time_is_utc(self):
        self.assertEqual(parse_time("2026-01-02T23:30+01:00").date(), date(2026, 1, 2))
        self.assertEqual(parse_time("2026-01-02T06:00Z").hour, 6)

    def test_missing_temperatures(self):
        self.assertIsNone(parse_temperature(""))
        self.assertIsNone(parse_temperature(" NA "))
        self.assertEqual(parse_temperature("-1.5"), -1.5)

    def test_read_sample(self):
        records = read_records(SAMPLE)
        self.assertEqual(station_ids(records), ["STN-01", "STN-02", "STN-03"])
        self.assertEqual(records[0].station, "STN-01")
        self.assertEqual(records[0].temperature, -2.5)

    def test_duplicates_are_skipped(self):
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, "dup.csv")
            with open(path, "w", encoding="utf-8") as handle:
                handle.write(
                    "station,time,temperature\nA,2026-01-01T00:00Z,1.0\nA,2026-01-01T00:00Z,2.0\n"
                )
            records = read_records(path)
        self.assertEqual([record.temperature for record in records], [1.0])

    def test_missing_column(self):
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, "bad.csv")
            with open(path, "w", encoding="utf-8") as handle:
                handle.write("station,time\nA,2026-01-01T00:00Z\n")
            with self.assertRaises(ValueError):
                read_records(path)


if __name__ == "__main__":
    unittest.main()
