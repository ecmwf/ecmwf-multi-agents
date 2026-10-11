# SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
# SPDX-License-Identifier: Apache-2.0

"""Daily summaries of station temperatures."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date

from .quality import split_valid
from .units import convert

DEFAULT_PRECISION = 1


@dataclass(frozen=True)
class DailySummary:
    """Minimum, maximum and mean temperature of one station on one UTC day."""

    station: str
    date: date
    minimum: float
    maximum: float
    mean: float
    count: int
    rejected: int = 0


def daily_summaries(records, unit="C", precision=DEFAULT_PRECISION):
    """Summarise the valid readings per station and UTC day, sorted by station and date.

    Temperatures are converted to `unit`, then rounded to `precision` decimal places. Missing
    readings are skipped; readings that fail the quality check are counted in `rejected`.
    Days without a valid reading are left out.
    """
    valid, rejected = split_valid(records)
    groups = {}
    for record in valid:
        groups.setdefault((record.station, record.date), []).append(
            convert(record.temperature, "C", unit)
        )
    rejected_counts = {}
    for record in rejected:
        key = (record.station, record.date)
        rejected_counts[key] = rejected_counts.get(key, 0) + 1
    summaries = []
    for (station, day), values in sorted(groups.items()):
        summaries.append(
            DailySummary(
                station=station,
                date=day,
                minimum=round(min(values), precision),
                maximum=round(max(values), precision),
                mean=round(sum(values) / len(values), precision),
                count=len(values),
                rejected=rejected_counts.get((station, day), 0),
            )
        )
    return summaries


def for_station(summaries, station):
    """Only the summaries of one station."""
    return [summary for summary in summaries if summary.station == station]
