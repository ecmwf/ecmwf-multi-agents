# SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
# SPDX-License-Identifier: Apache-2.0

"""Plausibility checks for temperature readings.

A reading outside the valid range is taken to be a sensor fault. Such readings stay in the
records, but the daily summaries leave them out and count them as rejected.
"""

VALID_MIN_C = -90.0
VALID_MAX_C = 60.0


def is_valid(temperature):
    """True when a reading is present and within the valid range, limits included."""
    return temperature is not None and VALID_MIN_C <= temperature <= VALID_MAX_C


def split_valid(records):
    """Split records into (valid, rejected); missing readings are in neither list."""
    valid = []
    rejected = []
    for record in records:
        if record.temperature is None:
            continue
        if is_valid(record.temperature):
            valid.append(record)
        else:
            rejected.append(record)
    return valid, rejected
