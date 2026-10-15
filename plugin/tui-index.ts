// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// TUI bundle entry. tools/bundle-plugin.ts replaces the constant below with the harness name
// when it builds tui.js in the plugin folder. Tests import ./tui.ts instead.

import { createTui } from "./tui.ts";

declare const __ECMWF_MULTI_AGENTS_NAME__: string;

export default createTui(__ECMWF_MULTI_AGENTS_NAME__);
