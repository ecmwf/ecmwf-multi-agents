# SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
# SPDX-License-Identifier: Apache-2.0

"""Reading station temperature records from CSV files.

A file starts with a header line naming the columns station, time and temperature. Times are
ISO 8601 in UTC, such as 2026-01-02T06:00Z; temperatures are in degrees Celsius. An empty
temperature or NA means the reading is missing. Lines that start with # are comments.
"""

from __future__ import annotations

import csv
from dataclasses import dataclass
from datetime import date, datetime, timezone

COLUMNS = ("station", "time", "temperature")
MISSING = ("", "NA")


@dataclass(frozen=True)
class Record:
    """One reading: station id, UTC time, and degrees Celsius or None when missing."""

    station: str
    time: datetime
    temperature: float | None

    @property
    def date(self) -> date:
        """The UTC date of the reading."""
        return self.time.date()


def parse_time(text):
    """Parse an ISO 8601 time; a time without a zone is taken as UTC."""
    text = text.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    value = datetime.fromisoformat(text)
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def parse_temperature(text):
    """Parse a temperature field; return None for a missing value."""
    text = text.strip()
    if text in MISSING:
        return None
    return float(text)


def parse_row(row):
    """Turn one CSV row, as a dict of column name to text, into a Record."""
    return Record(
        row["station"].strip(),
        parse_time(row["time"]),
        parse_temperature(row["temperature"]),
    )


def read_records(path):
    """Read the records of a CSV file, in file order.

    A second reading for the same station and time is a duplicate: it is skipped and the first
    one is kept.
    """
    records = []
    seen = set()
    with open(path, newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(line for line in handle if not line.startswith("#"))
        missing = [name for name in COLUMNS if name not in (reader.fieldnames or [])]
        if missing:
            raise ValueError(f"{path}: missing column(s): {', '.join(missing)}")
        for row in reader:
            record = parse_row(row)
            key = (record.station, record.time)
            if key in seen:
                continue
            seen.add(key)
            records.append(record)
    return records


def station_ids(records):
    """The station ids that occur in the records, sorted."""
    return sorted({record.station for record in records})
