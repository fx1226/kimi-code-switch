import { describe, expect, it } from "vitest";

import { DEFAULT_SERVER_PORT, parseServerArgs } from "./args";

describe("parseServerArgs", () => {
  it("returns defaults for an empty argv", () => {
    expect(parseServerArgs([])).toEqual({
      port: DEFAULT_SERVER_PORT,
      noOpen: false,
      dataDir: null,
      help: false,
    });
    expect(DEFAULT_SERVER_PORT).toBe(8417);
  });

  it("parses --port with a separate value", () => {
    expect(parseServerArgs(["--port", "18417"]).port).toBe(18417);
  });

  it("parses --port with an inline value", () => {
    expect(parseServerArgs(["--port=9000"]).port).toBe(9000);
  });

  it("parses --no-open", () => {
    expect(parseServerArgs(["--no-open"]).noOpen).toBe(true);
    expect(parseServerArgs([]).noOpen).toBe(false);
  });

  it("parses --data-dir with a separate value", () => {
    expect(parseServerArgs(["--data-dir", "/tmp/kimi-server-test"]).dataDir).toBe("/tmp/kimi-server-test");
  });

  it("parses --data-dir with an inline value containing equals signs", () => {
    expect(parseServerArgs(["--data-dir=/tmp/a=b"]).dataDir).toBe("/tmp/a=b");
  });

  it("parses --help and -h", () => {
    expect(parseServerArgs(["--help"]).help).toBe(true);
    expect(parseServerArgs(["-h"]).help).toBe(true);
  });

  it("rejects invalid ports", () => {
    expect(() => parseServerArgs(["--port", "abc"])).toThrow(/invalid port/);
    expect(() => parseServerArgs(["--port", "0"])).toThrow(/invalid port/);
    expect(() => parseServerArgs(["--port", "65536"])).toThrow(/invalid port/);
  });

  it("rejects missing option values", () => {
    expect(() => parseServerArgs(["--port"])).toThrow(/missing value for --port/);
    expect(() => parseServerArgs(["--data-dir"])).toThrow(/missing value for --data-dir/);
  });

  it("rejects unknown options", () => {
    expect(() => parseServerArgs(["--wat"])).toThrow(/unknown option: --wat/);
  });
});
