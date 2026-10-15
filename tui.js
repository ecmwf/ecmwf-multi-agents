// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// The plugin's TUI entry when a project's `plugins` line names this checkout: the TUI loads
// `tui.js` from a plugin folder (the npm package uses the "./tui" export instead).
export { default } from "./dist/opencode-v2/plugins/ecmwf-multi-agents/tui.js";
