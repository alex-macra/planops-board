import { describe, expect, it } from "vitest";

import { composeStatus, parseStatus } from "../server/ledger/statuses.ts";

describe("status qualifiers", () => {
  it.each([" - ", "; ", " \u2013 ", " \u2014 "])(
    "reads the %j separator",
    (separator) => {
      expect(parseStatus(`Ready${separator}review pending`, ["Ready"])).toEqual({
        base: "Ready",
        separator,
        qualifier: "review pending",
      });
    },
  );

  it("writes a plain-hyphen separator by default", () => {
    expect(composeStatus("Ready", "", "review pending")).toBe(
      "Ready - review pending",
    );
  });
});
