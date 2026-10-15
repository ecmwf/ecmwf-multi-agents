// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// The plugin's server entry when a project's `plugins` line names this checkout: opencode loads
// `server.js` from a plugin folder (the npm package uses the "./server" export instead).
export { default } from "./dist/opencode-v2/plugins/ecmwf-multi-agents/index.js";
