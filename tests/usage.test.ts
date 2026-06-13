import { describe, expect, test } from "vitest";
import { _test } from "../index.ts";
import { maskIdentifier, sanitizeDiagnosticError } from "../src/format.ts";

describe("usage helpers", () => {
  test("masks and sanitizes diagnostic identifiers", () => {
    expect(maskIdentifier("acct_1234567890abcdef")).toBe("acct...cdef");

    const sanitized = sanitizeDiagnosticError(
      `\u001b[31mAuthorization: Bearer sk-secretsecret accountId=acct_1234567890abcdef ${"x".repeat(700)}`,
    );

    expect(sanitized).not.toContain("\u001b");
    expect(sanitized).not.toContain("sk-secretsecret");
    expect(sanitized).not.toContain("acct_1234567890abcdef");
    expect(sanitized.length).toBeLessThanOrEqual(500);
  });

  test("formats percentages", () => {
    expect(_test.formatPercent(99.4)).toBe("99%");
    expect(_test.formatPercent(null)).toBe("--");
  });

  test("parses and formats usage snapshots", () => {
    const usage = _test.parseUsageSnapshot(
      {
        rate_limit: {
          allowed: true,
          primary_window: { used_percent: 1, reset_after_seconds: 60 },
          secondary_window: { used_percent: 49, reset_after_seconds: 3600 },
        },
      },
      "gpt-5.5",
    );
    expect(usage.fiveHourLeftPercent).toBe(99);
    expect(usage.sevenDayLeftPercent).toBe(51);
    expect(usage.isLimited).toBe(false);
    expect(_test.formatUsageSnapshot(usage, { showResetTimes: false })).toMatch(
      /^Usage: 5h: 99% \| 7d: 51%$/,
    );
  });
});
