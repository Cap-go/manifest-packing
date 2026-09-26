import { describe, expect, it } from "vitest";
import * as paths from "../src/paths.js";
import { Reader } from "../src/binary.js";

describe("allocation-light path helpers", () => {
  it("encodes filename segments exactly, including literal percent escapes", () => {
    expect(paths.encodePathName).toBeTypeOf("function");
    const names = [
      "assets/chunk-0123456789ABCDEF.js",
      "AZaz09-_.!~*'()/nested/file.css",
      "",
      "//",
      "a%2Fb/%2f/%252F",
      "space here/query?hash#and&plus+semi;colon:equals=",
      "name\n",
      "name\r",
      "name\r\n",
      "name\u2028",
      "name\u2029",
      "\uFEFF/é/e\u0301/日本語/😀.js",
      ...Array.from({ length: 128 }, (_, i) => `a/${String.fromCharCode(i)}/z`)
    ];
    for (const name of names) {
      expect(paths.encodePathName(name)).toBe(
        name.split("/").map(encodeURIComponent).join("/")
      );
    }
  });

  it("keeps malformed UTF-16 errors at the URI boundary", () => {
    expect(paths.encodePathName).toBeTypeOf("function");
    for (const name of ["a/\uD800", "\uDC00/b", "a\uD800x"])
      expect(() => paths.encodePathName(name)).toThrow(URIError);
  });

  it("converts hash slices without including bytes outside a reader view", () => {
    const source = Buffer.from([99, 88, 0, 1, 254, 255, 77, 66]);
    const reader = new Reader(source.subarray(2, 6));
    expect(reader.encoded).toBeTypeOf("function");
    expect(reader.encoded(2, "hex")).toBe("0001");
    expect(reader.encoded(2, "base64")).toBe("/v8=");
    expect(reader.offset).toBe(4);
    expect(() => reader.encoded(1, "hex")).toThrow("Truncated field");
    expect(reader.offset).toBe(4);
    expect(reader.encoded(0, "hex")).toBe("");
  });
});
