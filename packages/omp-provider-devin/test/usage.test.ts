// ABOUTME: Tests the neutral DevinProviderUsage → OMP UsageReport projection.

import { describe, expect, it } from "vitest";
import { toUsageReport } from "../src/usage.js";

describe("toUsageReport", () => {
  it("maps credit buckets and quota windows", () => {
    const report = toUsageReport("devin", {
      planName: "Devin Pro",
      email: "u@example.com",
      overageBalanceUsd: 1.5,
      limits: [
        {
          id: "devin:credits:prompt",
          label: "Prompt Credits",
          window: "monthly",
          used: 25,
          limit: 100,
          remaining: 75,
          unit: "credits",
          usedFraction: 0.25,
          resetsAt: 1_800_000_000_000,
        },
        {
          id: "devin:quota:daily",
          label: "Daily Quota",
          window: "daily",
          used: 5,
          limit: 100,
          remaining: 95,
          unit: "percent",
          usedFraction: 0.05,
        },
      ],
      raw: {} as never,
    });
    expect(report.provider).toBe("devin");
    expect(report.limits).toHaveLength(2);
    expect(report.limits[0]).toMatchObject({
      id: "devin:credits:prompt",
      amount: { used: 25, limit: 100, remaining: 75 },
      status: "ok",
    });
    expect(report.limits[1].window?.id).toBe("daily");
    expect(report.notes ?? []).toContain("Overage balance: $1.50");
    expect(report.metadata?.planType).toBe("Devin Pro");
  });
});
