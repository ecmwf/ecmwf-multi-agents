# SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
# SPDX-License-Identifier: Apache-2.0

import contextlib
import io
import os
import unittest

from stations.cli import main

SAMPLE = os.path.join(os.path.dirname(__file__), "..", "data", "sample.csv")


def run(*args):
    out = io.StringIO()
    err = io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = main(list(args))
    return code, out.getvalue(), err.getvalue()


class CliTest(unittest.TestCase):
    def test_summary_table(self):
        code, out, _ = run("summary", SAMPLE, "--station", "STN-01", "--precision", "1")
        self.assertEqual(code, 0)
        lines = out.splitlines()
        self.assertTrue(lines[0].startswith("station"))
        self.assertEqual(len(lines), 4)
        self.assertIn("2026-01-01", lines[1])
        self.assertIn("-2.5", lines[1])
        self.assertEqual(lines[-1], "Temperatures in degrees Celsius.")

    def test_stations(self):
        code, out, _ = run("stations", SAMPLE)
        self.assertEqual(code, 0)
        self.assertEqual(out.split(), ["STN-01", "STN-02", "STN-03"])

    def test_missing_file(self):
        code, _, err = run("summary", "no-such-file.csv")
        self.assertEqual(code, 1)
        self.assertIn("no-such-file.csv", err)


if __name__ == "__main__":
    unittest.main()
