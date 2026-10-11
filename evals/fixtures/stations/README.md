<!--
SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
SPDX-License-Identifier: Apache-2.0
-->

# stations

Daily summaries of temperature readings from weather stations. The package reads readings
from a CSV file, sets aside implausible values, and reports the minimum, maximum and mean
temperature of each station on each day, in degrees Celsius, degrees Fahrenheit or kelvin.

It needs Python 3.10 or later and nothing outside the standard library.

## Input

A CSV file with a header line and the columns `station`, `time` and `temperature`:

```text
station,time,temperature
STN-01,2026-01-01T06:00Z,-2.5
STN-01,2026-01-01T12:00Z,NA
```

Times are ISO 8601 in UTC. Temperatures are in degrees Celsius; an empty field or `NA` marks a
missing reading. Lines that start with `#` are comments. `data/sample.csv` has a week's worth
of examples from three test stations.

## Usage

```sh
python3 -m stations summary data/sample.csv
python3 -m stations summary data/sample.csv --unit F --station STN-02
python3 -m stations stations data/sample.csv
```

`summary` prints one line per station and day with the minimum, maximum, mean, the number of
readings used and the number rejected by the quality check. `stations` lists the station ids.

## Layout

| Module | What it does |
|---|---|
| `stations/records.py` | Reads CSV files into records |
| `stations/quality.py` | Decides which readings are plausible |
| `stations/units.py` | Converts between temperature units |
| `stations/summary.py` | Builds the daily summaries |
| `stations/cli.py` | The command line |

## Tests

```sh
python3 -m unittest
```
