# SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
# SPDX-License-Identifier: Apache-2.0

import unittest
from datetime import date, datetime, timezone

from stations.quality import is_valid, split_valid
from stations.records import Record
from stations.summary import daily_summaries, for_station


def reading(station, hour, temperature, day=1):
    return Record(
        station, datetime(2026, 1, day, hour, tzinfo=timezone.utc), temperature
    )


class QualityTest(unittest.TestCase):
    def test_limits_are_valid(self):
        self.assertTrue(is_valid(-90.0))
        self.assertTrue(is_valid(60.0))
        self.assertFalse(is_valid(60.5))
        self.assertFalse(is_valid(None))

    def test_split_valid(self):
        valid, rejected = split_valid(
            [reading("A", 0, 1.0), reading("A", 1, None), reading("A", 2, 75.0)]
        )
        self.assertEqual([record.temperature for record in valid], [1.0])
        self.assertEqual([record.temperature for record in rejected], [75.0])


class SummaryTest(unittest.TestCase):
    def test_daily_values(self):
        records = [
            reading("A", 0, 2.0),
            reading("A", 6, 4.0),
            reading("A", 12, 9.0),
            reading("A", 18, 99.0),
        ]
        [summary] = daily_summaries(records, precision=1)
        self.assertEqual(
            (summary.minimum, summary.maximum, summary.mean), (2.0, 9.0, 5.0)
        )
        self.assertEqual((summary.count, summary.rejected), (3, 1))

    def test_grouped_by_station_and_day(self):
        records = [
            reading("B", 0, 1.0),
            reading("A", 0, 2.0),
            reading("A", 0, 3.0, day=2),
        ]
        summaries = daily_summaries(records, precision=1)
        self.assertEqual(
            [(item.station, item.date) for item in summaries],
            [("A", date(2026, 1, 1)), ("A", date(2026, 1, 2)), ("B", date(2026, 1, 1))],
        )
        self.assertEqual(len(for_station(summaries, "A")), 2)

    def test_unit(self):
        [summary] = daily_summaries([reading("A", 0, 10.0)], unit="F", precision=1)
        self.assertEqual(summary.mean, 50.0)

    def test_day_without_valid_readings_is_left_out(self):
        self.assertEqual(
            daily_summaries(
                [reading("A", 0, None), reading("A", 1, -120.0)], precision=1
            ),
            [],
        )


if __name__ == "__main__":
    unittest.main()
