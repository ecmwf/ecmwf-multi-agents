// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// The module object opencode 2 loads: an id and `setup` (docs/research/opencode-v2.md, section 7).
// opencode does not bind `this`, so `setup` is a plain closure.

import type { EmbeddedHarness } from "./types.ts";
import { createSetup, type V2Options } from "./v2.ts";

export interface PluginModule {
  id: string;
  setup: ReturnType<typeof createSetup>;
}

export function createPlugin(harness: EmbeddedHarness, options: V2Options = {}): PluginModule {
  return {
    id: harness.name,
    setup: createSetup(harness, options),
  };
}
