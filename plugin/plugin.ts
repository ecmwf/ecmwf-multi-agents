// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// One module object for both platforms: opencode 1.x calls `server` and ignores `setup`;
// opencode 2.0.16 calls `setup` and ignores `server` (docs/research/opencode-v2.md, section 7).
// Neither binds `this`, so both entries are plain closures.

import type { EmbeddedHarness } from "./types.ts";
import { createServer, type V1Options } from "./v1.ts";
import { createSetup, type V2Options } from "./v2.ts";

export interface PluginModule {
  id: string;
  server: ReturnType<typeof createServer>;
  setup: ReturnType<typeof createSetup>;
}

export function createPlugin(harness: EmbeddedHarness, options: V1Options & V2Options = {}): PluginModule {
  return {
    id: harness.name,
    server: createServer(harness, options),
    setup: createSetup(harness, options),
  };
}
