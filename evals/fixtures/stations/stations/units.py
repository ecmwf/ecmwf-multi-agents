# SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
# SPDX-License-Identifier: Apache-2.0

"""Temperature unit conversions.

Units are named by their symbol: "C" (degrees Celsius), "F" (degrees Fahrenheit) and "K"
(kelvin).
"""

UNITS = ("C", "F", "K")

ABSOLUTE_ZERO_C = -273.15


def celsius_to_fahrenheit(value):
    """Convert degrees Celsius to degrees Fahrenheit."""
    return value * 9 / 5 + 32


def fahrenheit_to_celsius(value):
    """Convert degrees Fahrenheit to degrees Celsius."""
    return (value - 32) * 5 / 9


def celsius_to_kelvin(value):
    """Convert degrees Celsius to kelvin."""
    return value - ABSOLUTE_ZERO_C


def kelvin_to_celsius(value):
    """Convert kelvin to degrees Celsius."""
    return value + ABSOLUTE_ZERO_C


def convert(value, source, target):
    """Convert a temperature between two of the units in UNITS."""
    for unit in (source, target):
        if unit not in UNITS:
            raise ValueError(
                f"unknown unit {unit!r}; expected one of {', '.join(UNITS)}"
            )
    if source == target:
        return value
    return _FROM_CELSIUS[target](_TO_CELSIUS[source](value))


def _same(value):
    return value


_TO_CELSIUS = {
    "C": _same,
    "F": fahrenheit_to_celsius,
    "K": kelvin_to_celsius,
}

_FROM_CELSIUS = {
    "C": _same,
    "F": celsius_to_fahrenheit,
    "K": celsius_to_kelvin,
}
