// ABOUTME: Account plan + credit usage via SeatManagementService/GetUserStatus —
// ABOUTME: the single RPC the native CLI issues for quota display at startup.

import { DEVIN_GET_USER_STATUS_PATH, type FetchImpl, postDevinUnary } from "./client.js";
import { DevinApiError } from "./errors.js";
import {
  BillingStrategy,
  GetUserStatusRequestSchema,
  type GetUserStatusResponse,
  GetUserStatusResponseSchema,
  MetadataSchema,
  type PlanInfo,
  TeamsTier,
  type Timestamp,
} from "./proto/devin-messages.js";
import { create } from "./proto/protobuf.js";
import { logger } from "./util.js";
import { DEVIN_DEFAULT_BASE_URL, DEVIN_SESSION_TOKEN_PREFIX, devinCliMetadata, devinWireMetadata } from "./wire.js";

const MICROS_PER_USD = 1_000_000;

export type DevinUsageUnit = "credits" | "percent" | "unknown";
export type DevinUsageWindowId = "monthly" | "daily" | "weekly";

/** One normalized quota line item, host-agnostic. */
export interface DevinUsageLimit {
  id: string;
  label: string;
  window: DevinUsageWindowId;
  used: number;
  /** Monthly grant; absent for percent windows and zero-grant buckets. */
  limit?: number;
  remaining: number;
  unit: DevinUsageUnit;
  /** 0..1 when a grant exists. */
  usedFraction?: number;
  resetsAt?: number;
}

/** Plan/account facts a host may display beside the quota list. */
export interface DevinProviderUsage {
  email?: string;
  accountId?: string;
  orgId?: string;
  orgName?: string;
  planName?: string;
  /** Epoch ms the billing cycle ends. */
  planEnd?: number;
  overageBalanceUsd?: number;
  limits: DevinUsageLimit[];
  /** The raw decoded response, for hosts that want fields we did not map. */
  raw: GetUserStatusResponse;
}

function timestampMs(timestamp: Timestamp): number {
  return Number(timestamp.seconds) * 1_000 + timestamp.nanos / 1_000_000;
}

/** `TEAMS_TIER_DEVIN_PRO` → `Devin Pro`, for plans that ship no `plan_name`. */
function devinTierLabel(tier: TeamsTier): string | undefined {
  if (tier === TeamsTier.UNSPECIFIED) return undefined;
  const name = TeamsTier[tier];
  if (!name) return undefined;
  return name
    .toLowerCase()
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

interface DevinCreditBucket {
  id: string;
  label: string;
  limit: number;
  used: number;
  /** Server-reported balance — top-ups make this diverge from `limit - used`. */
  available: number;
}

function devinCreditLimit(bucket: DevinCreditBucket, resetsAt: number | undefined): DevinUsageLimit | undefined {
  const limit = bucket.limit > 0 ? bucket.limit : undefined;
  const used = Math.max(0, bucket.used);
  const remaining = Math.max(0, bucket.available);
  if (limit === undefined && used === 0 && remaining === 0) return undefined;
  return {
    id: `devin:credits:${bucket.id}`,
    label: bucket.label,
    window: "monthly",
    used,
    remaining,
    ...(limit !== undefined ? { limit, usedFraction: used / limit } : {}),
    unit: "credits",
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  };
}

interface DevinQuotaWindow {
  id: "daily" | "weekly";
  label: string;
  /** `*_quota_remaining_percent`, 0..100. */
  remainingPercent: number;
  /** `*_quota_reset_at_unix`, epoch seconds; 0 when the plan has no such window. */
  resetAtUnix: bigint;
  hidden: boolean;
}

/**
 * Credit-billed plans leave the quota percents at their proto defaults, which
 * would read as a fully consumed window. Only surface a percent window when
 * the server dated it, or the plan is explicitly quota-billed.
 */
function devinQuotaApplies(quota: DevinQuotaWindow, plan: PlanInfo | undefined): boolean {
  if (quota.hidden) return false;
  if (quota.resetAtUnix > 0n) return true;
  return plan?.billingStrategy === BillingStrategy.QUOTA;
}

function devinQuotaLimit(quota: DevinQuotaWindow): DevinUsageLimit {
  const remaining = Math.max(0, Math.min(100, quota.remainingPercent));
  const used = 100 - remaining;
  const resetAt = Number(quota.resetAtUnix);
  return {
    id: `devin:quota:${quota.id}`,
    label: quota.label,
    window: quota.id,
    used,
    limit: 100,
    remaining,
    usedFraction: used / 100,
    unit: "percent",
    ...(resetAt > 0 ? { resetsAt: resetAt * 1000 } : {}),
  };
}

/** Shape a decoded `GetUserStatusResponse` into the neutral usage record. */
export function buildDevinUsageReport(response: GetUserStatusResponse): DevinProviderUsage | null {
  const userStatus = response.userStatus;
  if (!userStatus) return null;
  const planStatus = userStatus.planStatus;
  // `planInfo` is the authoritative copy; the nested `plan_status` one only
  // fills in for older servers.
  const plan = response.planInfo ?? planStatus?.planInfo;
  const email = userStatus.email.trim() || undefined;
  const accountId = userStatus.userId.trim() || undefined;
  const orgId = plan?.devinInfo?.orgId.trim() || userStatus.teamId.trim() || undefined;
  const orgName = plan?.devinInfo?.accountDisplayName.trim() || undefined;
  const planName = plan?.planName.trim() || devinTierLabel(plan?.teamsTier ?? userStatus.teamsTier);
  const planEnd = planStatus?.planEnd ? timestampMs(planStatus.planEnd) : undefined;

  const limits: DevinUsageLimit[] = [];
  if (planStatus) {
    const resetsAt = planEnd !== undefined && planEnd > 0 ? planEnd : undefined;
    const buckets: DevinCreditBucket[] = [
      {
        id: "prompt",
        label: "Prompt Credits",
        limit: plan?.monthlyPromptCredits ?? 0,
        used: planStatus.usedPromptCredits,
        available: planStatus.availablePromptCredits,
      },
      {
        id: "flow",
        label: "Flow Credits",
        limit: plan?.monthlyFlowCredits ?? 0,
        used: planStatus.usedFlowCredits,
        available: planStatus.availableFlowCredits,
      },
      {
        id: "flex",
        label: "Flex Credits",
        limit: plan?.monthlyFlexCreditPurchaseAmount ?? 0,
        used: planStatus.usedFlexCredits,
        available: planStatus.availableFlexCredits,
      },
    ];
    for (const bucket of buckets) {
      const limit = devinCreditLimit(bucket, resetsAt);
      if (limit) limits.push(limit);
    }
    const quotas: DevinQuotaWindow[] = [
      {
        id: "daily",
        label: "Daily Quota",
        remainingPercent: planStatus.dailyQuotaRemainingPercent,
        resetAtUnix: planStatus.dailyQuotaResetAtUnix,
        hidden: plan?.hideDailyQuota === true,
      },
      {
        id: "weekly",
        label: "Weekly Quota",
        remainingPercent: planStatus.weeklyQuotaRemainingPercent,
        resetAtUnix: planStatus.weeklyQuotaResetAtUnix,
        hidden: plan?.hideWeeklyQuota === true,
      },
    ];
    for (const quota of quotas) {
      if (devinQuotaApplies(quota, plan)) limits.push(devinQuotaLimit(quota));
    }
  }

  const overageBalanceUsd = Number(planStatus?.overageBalanceMicros ?? 0n) / MICROS_PER_USD;
  return {
    ...(email !== undefined ? { email } : {}),
    ...(accountId !== undefined ? { accountId } : {}),
    ...(orgId !== undefined ? { orgId } : {}),
    ...(orgName !== undefined ? { orgName } : {}),
    ...(planName !== undefined ? { planName } : {}),
    ...(planEnd !== undefined && planEnd > 0 ? { planEnd } : {}),
    ...(overageBalanceUsd !== 0 ? { overageBalanceUsd } : {}),
    limits,
    raw: response,
  };
}

export interface DevinUsageFetchOptions {
  /**
   * Session token; the wire format's `devin-session-token$` prefix is added.
   * A raw legacy Windsurf Enterprise key is retried as-is after a 401.
   */
  apiKey?: string;
  baseUrl?: string;
  signal?: AbortSignal;
  fetch?: FetchImpl;
}

/**
 * Fetch the account's plan + credit usage. Returns `null` on request/decode
 * failure — the usage panel is advisory and must not surface as an outage.
 */
export async function fetchDevinUsage(options: DevinUsageFetchOptions): Promise<DevinProviderUsage | null> {
  const token = options.apiKey?.trim();
  if (!token) return null;
  const baseUrl = (options.baseUrl ?? DEVIN_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const requestStatus = (metadata: Record<string, unknown>) =>
    postDevinUnary(
      baseUrl,
      DEVIN_GET_USER_STATUS_PATH,
      GetUserStatusRequestSchema,
      GetUserStatusResponseSchema,
      create(GetUserStatusRequestSchema, { metadata: create(MetadataSchema, metadata) }),
      options.fetch ?? fetch,
      options.signal,
      "user status",
    );
  try {
    let decoded: Awaited<ReturnType<typeof requestStatus>>;
    try {
      decoded = await requestStatus(devinCliMetadata(token));
    } catch (error) {
      // A legacy Windsurf Enterprise API key is rejected in session-token form;
      // retry once with the raw key, mirroring GetUserJwt.
      if (!(error instanceof DevinApiError) || error.status !== 401 || token.startsWith(DEVIN_SESSION_TOKEN_PREFIX)) {
        throw error;
      }
      decoded = await requestStatus(devinWireMetadata(token));
    }
    const report = decoded ? buildDevinUsageReport(decoded) : null;
    if (!report) logger.warn("Devin user status response carried no usable status");
    return report;
  } catch (error) {
    logger.warn("Devin user status request failed", {
      error: error instanceof Error ? error.name : "unknown",
    });
    return null;
  }
}
