# SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
# SPDX-License-Identifier: Apache-2.0

"""Command-line interface: python3 -m stations COMMAND FILE [options]."""

import argparse
import sys

from .records import read_records, station_ids
from .summary import DEFAULT_PRECISION, daily_summaries, for_station
from .units import UNITS

UNIT_NAMES = {"C": "degrees Celsius", "F": "degrees Fahrenheit", "K": "kelvin"}


def build_parser():
    """The argument parser with the summary and stations commands."""
    parser = argparse.ArgumentParser(
        prog="stations",
        description="Summarise station temperature records from a CSV file.",
    )
    commands = parser.add_subparsers(dest="command", required=True)

    summary = commands.add_parser(
        "summary", help="daily minimum, maximum and mean per station"
    )
    summary.add_argument(
        "file", help="CSV file with station, time and temperature columns"
    )
    summary.add_argument(
        "--unit",
        choices=UNITS,
        default="C",
        help="unit of the output (default: %(default)s)",
    )
    summary.add_argument("--station", help="only this station")
    summary.add_argument(
        "--precision",
        type=int,
        default=DEFAULT_PRECISION,
        help="decimal places (default: %(default)s)",
    )

    stations = commands.add_parser("stations", help="list the station ids in a file")
    stations.add_argument(
        "file", help="CSV file with station, time and temperature columns"
    )
    return parser


def format_table(summaries, unit, precision):
    """The summaries as an aligned text table, with a line naming the unit."""
    lines = [
        f"{'station':<8} {'date':<10} {'min':>8} {'max':>8} {'mean':>8} {'count':>5} {'rejected':>8}"
    ]
    for item in summaries:
        lines.append(
            f"{item.station:<8} {item.date.isoformat():<10} {item.minimum:>8.{precision}f} {item.maximum:>8.{precision}f}"
            f" {item.mean:>8.{precision}f} {item.count:>5} {item.rejected:>8}"
        )
    lines.append(f"Temperatures in {UNIT_NAMES[unit]}.")
    return "\n".join(lines)


def main(argv=None):
    """Run the command line; returns the exit status."""
    args = build_parser().parse_args(argv)
    try:
        records = read_records(args.file)
    except (OSError, ValueError) as error:
        print(f"stations: {error}", file=sys.stderr)
        return 1
    if args.command == "stations":
        for station in station_ids(records):
            print(station)
        return 0
    if args.precision < 0:
        print("stations: --precision must be 0 or more", file=sys.stderr)
        return 2
    summaries = daily_summaries(records, unit=args.unit, precision=args.precision)
    if args.station:
        summaries = for_station(summaries, args.station)
    print(format_table(summaries, args.unit, args.precision))
    return 0
