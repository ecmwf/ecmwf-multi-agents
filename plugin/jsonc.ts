// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// A small JSONC reader: JSON plus `//` and `/* */` comments and trailing commas, the dialect of
// opencode's own config files. Errors name the line and column in plain words, so a user can
// find the mistake. Objects have no prototype, so keys such as "__proto__" are ordinary keys.

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export class JsoncError extends Error {
  constructor(
    readonly reason: string,
    readonly line: number,
    readonly column: number,
  ) {
    super(`line ${line}, column ${column}: ${reason}`);
    this.name = "JsoncError";
  }
}

const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const ESCAPES: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

/** Parse JSONC text; throws JsoncError with the position of the first problem. */
export function parseJsonc(text: string): JsonValue {
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;

  const fail = (reason: string, at = i): never => {
    let line = 1;
    let start = 0;
    for (let k = 0; k < at && k < text.length; k++) {
      if (text[k] === "\n") {
        line++;
        start = k + 1;
      }
    }
    throw new JsoncError(reason, line, at - start + 1);
  };

  const describe = (at: number): string => (at >= text.length ? "the end of the file" : JSON.stringify(text[at]));

  const skip = (): void => {
    while (i < text.length) {
      const c = text[i];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") {
        i++;
      } else if (c === "/" && text[i + 1] === "/") {
        while (i < text.length && text[i] !== "\n") i++;
      } else if (c === "/" && text[i + 1] === "*") {
        const end = text.indexOf("*/", i + 2);
        if (end === -1) fail("a /* comment is never closed");
        i = end + 2;
      } else {
        return;
      }
    }
  };

  const string = (): string => {
    const start = i;
    i++;
    let out = "";
    while (true) {
      if (i >= text.length) fail("text in double quotes is never closed", start);
      const c = text[i]!;
      if (c === '"') {
        i++;
        return out;
      }
      if (c === "\\") {
        const next = text[i + 1];
        if (next === "u") {
          const hex = text.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("\\u must be followed by four hexadecimal digits");
          out += String.fromCharCode(parseInt(hex, 16));
          i += 6;
          continue;
        }
        const escaped = next === undefined ? undefined : ESCAPES[next];
        if (escaped === undefined) fail(`${JSON.stringify(`\\${next ?? ""}`)} is not a valid escape in text`);
        out += escaped;
        i += 2;
        continue;
      }
      if (c < " ") fail("a line break or control character inside text in double quotes");
      out += c;
      i++;
    }
  };

  const value = (): JsonValue => {
    skip();
    const c = text[i];
    if (c === "{") return object();
    if (c === "[") return array();
    if (c === '"') return string();
    if (c === "-" || (c !== undefined && c >= "0" && c <= "9")) {
      NUMBER.lastIndex = i;
      const match = NUMBER.exec(text);
      if (match === null) return fail("not a valid number");
      i += match[0].length;
      return Number(match[0]);
    }
    for (const [word, result] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (text.startsWith(word, i)) {
        i += word.length;
        return result;
      }
    }
    if (c === "'") return fail("text must be in double quotes");
    return fail(`expected a value, found ${describe(i)}`);
  };

  const object = (): JsonValue => {
    const out: { [key: string]: JsonValue } = Object.create(null);
    i++;
    skip();
    if (text[i] === "}") {
      i++;
      return out;
    }
    while (true) {
      skip();
      if (text[i] !== '"') fail(`expected a key in double quotes, found ${describe(i)}`);
      const key = string();
      skip();
      if (text[i] !== ":") fail(`expected ":" after the key ${JSON.stringify(key)}, found ${describe(i)}`);
      i++;
      out[key] = value();
      skip();
      if (text[i] === ",") {
        i++;
        skip();
        if (text[i] === "}") {
          i++;
          return out;
        }
        continue;
      }
      if (text[i] === "}") {
        i++;
        return out;
      }
      fail(`expected "," or "}" after a value, found ${describe(i)}`);
    }
  };

  const array = (): JsonValue => {
    const out: JsonValue[] = [];
    i++;
    skip();
    if (text[i] === "]") {
      i++;
      return out;
    }
    while (true) {
      out.push(value());
      skip();
      if (text[i] === ",") {
        i++;
        skip();
        if (text[i] === "]") {
          i++;
          return out;
        }
        continue;
      }
      if (text[i] === "]") {
        i++;
        return out;
      }
      fail(`expected "," or "]" after a value, found ${describe(i)}`);
    }
  };

  skip();
  if (i >= text.length) fail("the file is empty; write {} for no settings");
  const result = value();
  skip();
  if (i < text.length) fail(`unexpected ${describe(i)} after the end of the settings`);
  return result;
}
