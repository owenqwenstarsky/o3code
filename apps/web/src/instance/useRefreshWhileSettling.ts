import type { InstanceWorkspace } from "@t3tools/contracts/instance";
import { useEffect } from "react";

const SETTLING_REFRESH_MS = 3_000;
const SETTLING_STATUSES: ReadonlySet<InstanceWorkspace["status"]> = new Set([
  "provisioning",
  "starting",
  "stopping",
]);

/**
 * Refetches while any workspace is changing state. The instance settles status in the background
 * and has no push channel, so a page would otherwise show "Starting" until reloaded.
 */
export function useRefreshWhileSettling(
  query: { readonly isPending: boolean; readonly refresh: () => void },
  workspaces: ReadonlyArray<InstanceWorkspace>,
) {
  const settling = workspaces.some((workspace) => SETTLING_STATUSES.has(workspace.status));
  const { isPending, refresh } = query;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a timer polls the instance, which has no push channel.
  useEffect(() => {
    if (!settling || isPending) return;
    const timer = window.setTimeout(refresh, SETTLING_REFRESH_MS);
    return () => window.clearTimeout(timer);
  }, [settling, isPending, refresh]);
}
