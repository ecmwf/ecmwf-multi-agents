// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { JsoncError, parseJsonc } from "./jsonc.ts";

function errorOf(text: string): JsoncError {
  try {
    parseJsonc(text);
  } catch (error) {
    if (error instanceof JsoncError) return error;
    throw error;
  }
  throw new Error(`no error for ${JSON.stringify(text)}`);
}

describe("parseJsonc", () => {
  test("reads plain JSON like JSON.parse", () => {
    const text = '{"a": [1, -2.5, 3e2, true, false, null], "b": {"c": "d\\n\\u00e9\\"x"}, "e": ""}';
    expect(parseJsonc(text)).toEqual(JSON.parse(text));
  });

  test("accepts line and block comments anywhere between tokens", () => {
    const text = `// settings
{
  /* the policy */ "review": "always", // trailing note
  "profile" /* inline */ : "anthropic"
  /* last */
}
// end`;
    expect(parseJsonc(text)).toEqual({ review: "always", profile: "anthropic" });
  });

  test("keeps comment markers inside text", () => {
    expect(parseJsonc('{"model": "a//b", "variant": "/* not a comment */"}')).toEqual({ model: "a//b", variant: "/* not a comment */" });
  });

  test("accepts trailing commas in objects and arrays", () => {
    expect(parseJsonc('{"a": [1, 2,], "b": {"c": 1,},}')).toEqual({ a: [1, 2], b: { c: 1 } });
  });

  test("skips a byte order mark and accepts CRLF line endings", () => {
    expect(parseJsonc('\uFEFF{\r\n  "review": "never"\r\n}\r\n')).toEqual({ review: "never" });
  });

  test("keeps the last of duplicate keys and treats __proto__ as an ordinary key", () => {
    const value = parseJsonc('{"a": 1, "a": 2, "__proto__": {"x": 1}}') as Record<string, unknown>;
    expect(value.a).toBe(2);
    expect(Object.keys(value)).toEqual(["a", "__proto__"]);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  test("reports the line and column of a missing comma", () => {
    const error = errorOf('{\n  "review": "auto"\n  "profile": "default"\n}');
    expect(error.line).toBe(3);
    expect(error.column).toBe(3);
    expect(error.message).toBe('line 3, column 3: expected "," or "}" after a value, found "\\""');
  });

  test("explains common mistakes in plain words", () => {
    expect(errorOf("").message).toContain("the file is empty");
    expect(errorOf("  // only a comment\n").message).toContain("the file is empty");
    expect(errorOf("{'review': 'auto'}").message).toContain("expected a key in double quotes");
    expect(errorOf('{"review": \'auto\'}').message).toContain("text must be in double quotes");
    expect(errorOf('{"review" "auto"}').message).toContain('expected ":" after the key "review"');
    expect(errorOf('{"review": "auto"').message).toContain('expected "," or "}" after a value, found the end of the file');
    expect(errorOf('{"review": "auto}').message).toContain("text in double quotes is never closed");
    expect(errorOf('{"a": 1} /* open').message).toContain("a /* comment is never closed");
    expect(errorOf('{"a": 1} {"b": 2}').message).toContain("after the end of the settings");
    expect(errorOf('{"a": [1 2]}').message).toContain('expected "," or "]"');
    expect(errorOf('{"a": tru}').message).toContain("expected a value");
    expect(errorOf('{"a": 01}').message).toContain('expected "," or "}"');
    expect(errorOf('{"a": "\\x"}').message).toContain("is not a valid escape");
    expect(errorOf('{"a": "\\u12"}').message).toContain("four hexadecimal digits");
    expect(errorOf('{"a": "line\nbreak"}').message).toContain("line break or control character");
    expect(errorOf("{,}").message).toContain("expected a key");
  });
});
