import { describe, expect, it } from "@effect/vitest";

import { presentConnectionDiagnosis } from "./diagnosis.ts";
import { mapRemoteEnvironmentError } from "./errors.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  ConnectionBlockedError,
  type ConnectionAttemptError,
  type SupervisorConnectionState,
} from "./model.ts";
import { RemoteEnvironmentAuthFetchError } from "../rpc/http.ts";

const backoff = (lastFailure: ConnectionAttemptError): SupervisorConnectionState => ({
  ...AVAILABLE_CONNECTION_STATE,
  desired: true,
  network: "online",
  phase: "backoff",
  attempt: 3,
  lastFailure,
  retryAt: Date.UTC(2026, 9, 19, 12, 0, 30),
});

const diagnose = (state: SupervisorConnectionState) =>
  presentConnectionDiagnosis({ hostLabel: "Mac mini", state });

const results = (state: SupervisorConnectionState) =>
  diagnose(state)?.hops.map((hop) => `${hop.hop}:${hop.result}`);

const unreachable = mapRemoteEnvironmentError(
  new RemoteEnvironmentAuthFetchError({ message: "Failed to fetch", cause: new TypeError() }),
);

describe("presentConnectionDiagnosis", () => {
  it("returns nothing before any attempt fails", () => {
    expect(diagnose(AVAILABLE_CONNECTION_STATE)).toBeNull();
  });

  it("blames O3 Code on the host when this device cannot reach it", () => {
    expect(diagnose(backoff(unreachable))?.headline).toBe("O3 Code on Mac mini did not answer");
    expect(results(backoff(unreachable))).toEqual(["device:ok", "server:failed"]);
  });

  it("tells a rejected credential apart from a host that did not answer", () => {
    const failure = new ConnectionBlockedError({
      reason: "authentication",
      detail: "The environment credential is invalid.",
      hop: "server",
    });
    expect(diagnose(backoff(failure))?.headline).toBe(
      "O3 Code on Mac mini did not accept this device",
    );
  });

  it("reports this device as offline before any other hop", () => {
    const state = { ...backoff(unreachable), network: "offline" as const };
    expect(diagnose(state)?.headline).toBe("This device is offline");
    expect(results(state)).toEqual(["device:failed", "server:unchecked"]);
  });
});
