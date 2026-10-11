# SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
# SPDX-License-Identifier: Apache-2.0

import unittest

from stations.units import (
    celsius_to_fahrenheit,
    celsius_to_kelvin,
    convert,
    fahrenheit_to_celsius,
    kelvin_to_celsius,
)


class UnitsTest(unittest.TestCase):
    def test_celsius_and_fahrenheit(self):
        self.assertAlmostEqual(celsius_to_fahrenheit(100.0), 212.0)
        self.assertAlmostEqual(fahrenheit_to_celsius(-40.0), -40.0)

    def test_celsius_and_kelvin(self):
        self.assertAlmostEqual(celsius_to_kelvin(0.0), 273.15)
        self.assertAlmostEqual(kelvin_to_celsius(0.0), -273.15)

    def test_convert(self):
        self.assertAlmostEqual(convert(10.0, "C", "F"), 50.0)
        self.assertAlmostEqual(convert(50.0, "F", "C"), 10.0)
        self.assertEqual(convert(3.5, "C", "C"), 3.5)

    def test_unknown_unit(self):
        with self.assertRaises(ValueError):
            convert(1.0, "C", "R")


if __name__ == "__main__":
    unittest.main()
