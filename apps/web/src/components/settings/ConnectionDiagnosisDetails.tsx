import { useAtomValue } from "@effect/atom-react";
import {
  AVAILABLE_CONNECTION_STATE,
  presentConnectionDiagnosis,
} from "@t3tools/client-runtime/connection";
import { AsyncResult } from "effect/reactivity";

import { APP_VERSION } from "~/branding";
import { environmentCatalog } from "~/connection/catalog";
import type { EnvironmentPresentation } from "~/state/environments";

/**
 * What failed on the way to an environment, or null while it is connected, off,
 * or has not failed. Reads the supervisor state itself so callers that only need
 * the headline do not re-render on every attempt.
 */
function useConnectionDiagnosis(environment: EnvironmentPresentation) {
  const environmentId = environment.environmentId;
  const state = AsyncResult.getOrElse(
    useAtomValue(environmentCatalog.stateAtom(environmentId)),
    () => AVAILABLE_CONNECTION_STATE,
  );
  const phase = environment.connection.phase;
  const diagnosis =
    environment.entry.enabled && phase !== "connected" && phase !== "unsupported"
      ? presentConnectionDiagnosis({
          hostLabel: environment.label,
          state,
          clientVersion: APP_VERSION,
          serverVersion: environment.serverConfig?.environment.serverVersion,
        })
      : null;
  return { diagnosis, state };
}

/** The failure headline alone, for banners outside Settings. */
export function ConnectionDiagnosisHeadline({
  environment,
}: {
  readonly environment: EnvironmentPresentation;
}) {
  return useConnectionDiagnosis(environment).diagnosis?.headline ?? null;
}
