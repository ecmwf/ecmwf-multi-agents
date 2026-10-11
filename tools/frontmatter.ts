// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// Minimal YAML writer for Markdown frontmatter. Supports the shapes the emitters need:
// strings, numbers, booleans, nested maps and lists. Strings that are not plain safe words
// are written as JSON strings, which YAML reads as double-quoted scalars. Key order is kept,
// because opencode permission maps are ordered (the last matching rule wins).

export type YamlValue = string | number | boolean | YamlValue[] | { [key: string]: YamlValue };

const PLAIN = /^[A-Za-z_][A-Za-z0-9_.\/-]*$/;
const RESERVED = /^(true|false|yes|no|on|off|null|~)$/i;

function scalar(value: string | number | boolean): string {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`frontmatter: non-finite number ${value}`);
    return String(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  return PLAIN.test(value) && !RESERVED.test(value) ? value : JSON.stringify(value);
}

function key(name: string): string {
  return PLAIN.test(name) && !RESERVED.test(name) ? name : JSON.stringify(name);
}

function isMap(value: YamlValue): value is { [key: string]: YamlValue } {
  return typeof value === "object" && !Array.isArray(value);
}

function lines(value: YamlValue, indent: string): string[] {
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${indent}[]`];
    const out: string[] = [];
    for (const item of value) {
      if (isMap(item) || Array.isArray(item)) {
        const inner = lines(item, `${indent}  `);
        out.push(`${indent}- ${inner[0]!.trimStart()}`, ...inner.slice(1));
      } else {
        out.push(`${indent}- ${scalar(item)}`);
      }
    }
    return out;
  }
  if (isMap(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return [`${indent}{}`];
    const out: string[] = [];
    for (const [name, item] of entries) {
      if ((isMap(item) && Object.keys(item).length > 0) || (Array.isArray(item) && item.length > 0)) {
        out.push(`${indent}${key(name)}:`, ...lines(item, `${indent}  `));
      } else if (isMap(item)) {
        out.push(`${indent}${key(name)}: {}`);
      } else if (Array.isArray(item)) {
        out.push(`${indent}${key(name)}: []`);
      } else {
        out.push(`${indent}${key(name)}: ${scalar(item)}`);
      }
    }
    return out;
  }
  return [`${indent}${scalar(value)}`];
}

/**
 * Render a Markdown document with YAML frontmatter.
 * `comment` lines (each starting with "#") are written first inside the frontmatter.
 */
export function withFrontmatter(
  data: { [key: string]: YamlValue },
  body: string,
  comment: string[] = [],
): string {
  for (const c of comment) {
    if (!c.startsWith("#")) throw new Error(`frontmatter: comment must start with '#': ${c}`);
  }
  const head = [...comment, ...lines(data, "")].join("\n");
  return `---\n${head}\n---\n\n${body.trim()}\n`;
}
