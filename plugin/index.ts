// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// Bundle entry. tools/bundle-plugin.ts replaces the constant below with the harness data
// (profiles and agents) when it builds plugins/ecmwf-multi-agents.js, so the plugin needs
// nothing at run time beyond Node built-ins. Tests import ./plugin.ts instead.

import { createPlugin } from "./plugin.ts";
import type { EmbeddedHarness } from "./types.ts";

declare const __ECMWF_MULTI_AGENTS_HARNESS__: EmbeddedHarness;

export default createPlugin(__ECMWF_MULTI_AGENTS_HARNESS__);
