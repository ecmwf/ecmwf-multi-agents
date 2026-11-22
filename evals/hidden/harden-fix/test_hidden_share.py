# SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
# SPDX-License-Identifier: Apache-2.0

# Hidden test for the harden-fix case: a folder name cannot run a command, through either
# function, and packing still works. Runs from the project root, which holds the stations package.

import os
import tempfile
import unittest

from stations.share import pack, pack_all


class HiddenShareTest(unittest.TestCase):
    def setUp(self):
        self.start = os.getcwd()
        self.dir = tempfile.TemporaryDirectory()
        os.chdir(self.dir.name)

    def tearDown(self):
        os.chdir(self.start)
        self.dir.cleanup()

    def folder(self, name):
        os.mkdir(name)
        with open(os.path.join(name, "readings.csv"), "w") as handle:
            handle.write("station,time,value\n")
        return name

    def test_pack_runs_no_command_from_the_name(self):
        pack(self.folder("a; touch PWNED"))
        self.assertFalse(os.path.exists("PWNED"))
        self.assertTrue(os.path.exists("a; touch PWNED.tar.gz"))

    def test_pack_all_runs_no_command_from_the_name(self):
        pack_all([self.folder("b $(touch PWNED2)")])
        self.assertFalse(os.path.exists("PWNED2"))
        self.assertTrue(os.path.exists("b $(touch PWNED2).tar.gz"))


if __name__ == "__main__":
    unittest.main()
