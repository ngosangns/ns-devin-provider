// ABOUTME: Projects Devin's account usage onto OMP's normalized usage report.

import type { UsageFetchContext, UsageFetchParams, UsageProvider, UsageReport } from "@oh-my-pi/pi-ai";
import { type DevinProviderUsage, fetchDevinUsage, normalizeDevinSessionToken } from "ns-devin-core";

function statusFromFraction(
  usedFraction: number | undefined,
  exhausted: boolean,
): "ok" | "warning" | "exhausted" | "unknown" {
  if (usedFraction === undefined) return exhausted ? "exhausted" : "unknown";
  if (usedFraction >= 1) return "exhausted";
  if (usedFraction >= 0.9) return "warning";
  return "ok";
}

/**
 * OMP's `/settings` usage panel over Devin's `GetUserStatus` response.
 *
 * The credential arrives from the host's auth storage rather than the CLI
 * store, because a user may hold several Devin accounts and the panel reports
 * the one it is asking about.
 */
export function toUsageReport(provider: string, usage: DevinProviderUsage, fetchedAt = Date.now()): UsageReport {
  const notes: string[] = [];
  if (usage.overageBalanceUsd !== undefined) {
    notes.push(`Overage balance: $${usage.overageBalanceUsd.toFixed(2)}`);
  }
  return {
    provider,
    fetchedAt,
    limits: usage.limits.map((limit) => ({
      id: limit.id,
      label: limit.label,
      scope: {
        provider,
        ...(usage.planName ? { tier: usage.planName } : {}),
        windowId: limit.window,
      },
      window: {
        id: limit.window,
        label: limit.window === "monthly" ? "Plan Period" : limit.label,
        ...(limit.resetsAt !== undefined ? { resetsAt: limit.resetsAt } : {}),
      },
      amount: {
        used: limit.used,
        ...(limit.limit !== undefined ? { limit: limit.limit } : {}),
        remaining: limit.remaining,
        ...(limit.usedFraction !== undefined
          ? { usedFraction: limit.usedFraction, remainingFraction: Math.max(0, 1 - limit.usedFraction) }
          : {}),
        unit: limit.unit === "percent" ? ("percent" as const) : ("unknown" as const),
      },
      status: statusFromFraction(limit.usedFraction, false),
    })),
    ...(notes.length > 0 ? { notes } : {}),
    metadata: {
      source: "seat-management",
      ...(usage.email !== undefined ? { email: usage.email } : {}),
      ...(usage.accountId !== undefined ? { accountId: usage.accountId } : {}),
      ...(usage.orgId !== undefined ? { orgId: usage.orgId } : {}),
      ...(usage.orgName !== undefined ? { orgName: usage.orgName } : {}),
      ...(usage.planName !== undefined ? { planType: usage.planName } : {}),
      ...(usage.planEnd !== undefined ? { planEnd: usage.planEnd } : {}),
    },
    raw: usage.raw,
  };
}

export const devinUsageProvider: UsageProvider = {
  id: "devin",

  async fetchUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null> {
    const raw = params.credential.accessToken ?? params.credential.apiKey;
    const token = raw?.trim();
    if (!token) return null;
    const usage = await fetchDevinUsage({
      apiKey: normalizeDevinSessionToken(token),
      ...(params.baseUrl ? { baseUrl: params.baseUrl } : {}),
      ...(params.signal ? { signal: params.signal } : {}),
      fetch: ctx.fetch,
    });
    return usage ? toUsageReport(params.provider, usage) : null;
  },

  validatesCredentials: true,
};
