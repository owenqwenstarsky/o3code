import { InstanceAccount } from "@t3tools/client-runtime/instance";
import { useNavigate } from "@tanstack/react-router";
import * as Effect from "effect/Effect";
import { useEffect } from "react";

import { runInstance } from "./instanceState";

// Notices a revoked session within minutes; tokens are only re-minted near expiry.
const REFRESH_INTERVAL_MS = 15 * 60 * 1000;

const refreshWorkspaces = InstanceAccount.pipe(
  Effect.flatMap((account) => account.refreshWorkspaces),
  Effect.as("connected" as const),
  Effect.catchTags({
    InstanceSignedOutError: () => Effect.succeed("signed-out" as const),
    InstanceWorkspaceUnavailableError: (error) =>
      Effect.logWarning("O3 workspace is unavailable.", { reason: error.reason }).pipe(
        Effect.as("unavailable" as const),
      ),
    InstanceUnreachableError: (error) =>
      Effect.logWarning("O3 instance is unreachable.", { message: error.message }).pipe(
        Effect.as("unavailable" as const),
      ),
  }),
);

/** Keeps this client's workspace token fresh, and signs out when the instance does. */
export function InstanceWorkspaceCoordinator() {
  const navigate = useNavigate();

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the saved workspace credential fresh against the instance on a timer
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void runInstance(refreshWorkspaces).then((outcome) => {
        if (!cancelled && outcome === "signed-out") void navigate({ to: "/login", replace: true });
      });
    };
    refresh();
    const timer = window.setInterval(refresh, REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [navigate]);

  return null;
}
