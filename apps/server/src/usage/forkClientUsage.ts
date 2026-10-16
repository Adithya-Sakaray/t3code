import type { UsageSummary } from "@t3tools/contracts";

// Fork builds carry `-adi.N` versions; only they know the `kiro` usage provider.
const FORK_CLIENT_VERSION = /-adi\.\d+$/;

/**
 * Drops Kiro usage for clients that are not fork builds. Upstream clients
 * decode RPC results through the exit codec, where an unknown `provider`
 * fails the whole summary instead of dropping that entry, so one Kiro bucket
 * would leave their Usage page showing no activity at all.
 */
export function usageSummaryForClient(
  summary: UsageSummary,
  clientAppVersion: string | undefined,
): UsageSummary {
  if (clientAppVersion !== undefined && FORK_CLIENT_VERSION.test(clientAppVersion)) {
    return summary;
  }
  return {
    ...summary,
    buckets: summary.buckets.filter((bucket) => bucket.provider !== "kiro"),
    sources: summary.sources.filter((source) => source.fingerprint.provider !== "kiro"),
  };
}
