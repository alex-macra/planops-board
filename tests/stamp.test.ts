import { describe, expect, it } from "vitest";

import { stamped, stampDateOf, withoutStamp } from "../shared/stamp.ts";

describe("status stamps", () => {
  it("appends and replaces the board-owned stamp", () => {
    const once = stamped("Record the observation.", "2026-08-20");
    expect(once).toBe("Record the observation. **Status set 2026-08-20.**");
    expect(stamped(once, "2026-08-21")).toBe(
      "Record the observation. **Status set 2026-08-21.**",
    );
  });

  it("writes a stamp into an empty outcome", () => {
    expect(stamped("", "2026-08-20")).toBe("**Status set 2026-08-20.**");
  });

  it("preserves handwritten dated prose", () => {
    const prose = "**Reviewed 2026-08-20:** the fictional observation is clear.";
    expect(withoutStamp(prose)).toBe(prose);
    expect(stamped(prose, "2026-08-21")).toBe(
      `${prose} **Status set 2026-08-21.**`,
    );
  });

  it("strips only a terminal board stamp", () => {
    const middle = "**Status set 2026-08-20.** remains quoted in this sentence.";
    expect(withoutStamp(middle)).toBe(middle);
    expect(withoutStamp("Outcome. **Status set 2026-08-20.**")).toBe("Outcome.");
  });

  it("reads a board stamp date", () => {
    expect(stampDateOf(stamped("Outcome.", "2026-08-20"))).toBe("2026-08-20");
    expect(stampDateOf("Outcome.")).toBeNull();
  });
});
