import { EnvironmentId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { HttpClient, HttpClientResponse } from "effect/http";

import type { BearerConnectionRegistration } from "../connection/catalog.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import {
  InstanceAccount,
  InstanceSessionStore,
  layer as layerInstanceAccount,
  type StoredInstanceSession,
} from "./account.ts";

interface FakeInstance {
  workspaceUrl: string;
  sessionValid: boolean;
  meCalls: number;
  tokenCalls: number;
}

const environmentId = EnvironmentId.make("workspace-env");

const user = {
  id: "user-1",
  email: "alice@acme.test",
  name: "Alice",
  role: "member",
  disabled: false,
  mustChangePassword: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  lastLoginAt: null,
};

const workspaceFor = (instance: FakeInstance) => ({
  userId: "user-1",
  slug: "alice",
  status: "running",
  statusMessage: null,
  tailnetHostname: new URL(instance.workspaceUrl).host,
  httpBaseUrl: instance.workspaceUrl,
  wsBaseUrl: instance.workspaceUrl.replace(/^http/, "ws"),
  image: "o3code/workspace:test",
  tools: [],
  limits: { cpus: 2, memoryMb: 2048, pids: 1024 },
  diskUsageBytes: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const layerFakeHttp = (instance: FakeInstance) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        const path = new URL(request.url).pathname;
        const json = (body: unknown, status = 200) =>
          HttpClientResponse.fromWeb(request, Response.json(body, { status }));
        if (path === "/o3/api/auth/me") {
          instance.meCalls += 1;
          return instance.sessionValid
            ? json({ user, workspace: workspaceFor(instance), sessionId: "session-1" })
            : json(
                {
                  _tag: "InstanceUnauthorizedError",
                  reason: "session_expired",
                  message: "Your session has ended.",
                },
                401,
              );
        }
        if (path === "/o3/api/workspace/token") {
          instance.tokenCalls += 1;
          return json({
            token: `o3w_token-${instance.tokenCalls}`,
            expiresAt: "2099-01-01T00:00:00.000Z",
            workspace: workspaceFor(instance),
          });
        }
        if (path === "/.well-known/t3/environment") {
          return json({
            environmentId,
            label: "Workspace",
            platform: { os: "linux", arch: "arm64" },
            serverVersion: "0.0.0-test",
            capabilities: { repositoryIdentity: true },
          });
        }
        return json({}, 404);
      }),
    ),
  );

interface RegistryCalls {
  readonly registered: Array<BearerConnectionRegistration>;
  readonly removed: Array<EnvironmentId>;
}

// The account only registers, enables and removes the workspace environment.
const layerFakeRegistry = (calls: RegistryCalls) =>
  Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, {
    register: (registration: BearerConnectionRegistration) =>
      Effect.sync(() => {
        calls.registered.push(registration);
        return true;
      }),
    setEnabled: () => Effect.void,
    remove: (id: EnvironmentId) =>
      Effect.sync(() => {
        calls.removed.push(id);
      }),
  } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);

const layerSessionStore = (initial: StoredInstanceSession) =>
  Layer.effect(
    InstanceSessionStore,
    Ref.make(Option.some(initial)).pipe(
      Effect.map((ref) =>
        InstanceSessionStore.of({
          get: Ref.get(ref),
          set: (session) => Ref.set(ref, Option.some(session)),
          clear: Ref.set(ref, Option.none()),
        }),
      ),
    ),
  );

const signedIn: StoredInstanceSession = {
  url: "https://o3.tail.ts.net",
  name: "Acme",
  sessionToken: "o3s_session",
  userId: "user-1",
  email: "alice@acme.test",
  environmentId,
  workspaceTokenExpiresAt: "2099-01-01T00:00:00.000Z",
  workspaceHttpBaseUrl: "https://o3-alice.tail.ts.net",
};

const layerAccount = (instance: FakeInstance, calls: RegistryCalls) =>
  layerInstanceAccount.pipe(
    Layer.provideMerge(layerSessionStore(signedIn)),
    Layer.provide(layerFakeRegistry(calls)),
    Layer.provide(layerFakeHttp(instance)),
  );

it.effect("re-registers the workspace when its address changes, even with a fresh token", () => {
  const instance: FakeInstance = {
    workspaceUrl: "https://o3-alice.tail.ts.net",
    sessionValid: true,
    meCalls: 0,
    tokenCalls: 0,
  };
  const calls: RegistryCalls = { registered: [], removed: [] };
  return Effect.gen(function* () {
    const account = yield* InstanceAccount;

    yield* account.refreshWorkspace;
    expect(instance.meCalls).toBe(1);
    expect(calls.registered).toHaveLength(0);

    instance.workspaceUrl = "https://o3-alice-1.tail.ts.net";
    yield* account.refreshWorkspace;
    expect(instance.tokenCalls).toBe(1);
    expect(calls.registered.map((registration) => registration.profile.httpBaseUrl)).toEqual([
      "https://o3-alice-1.tail.ts.net",
    ]);
    const session = Option.getOrThrow(yield* account.session);
    expect(session.workspaceHttpBaseUrl).toBe("https://o3-alice-1.tail.ts.net");
  }).pipe(Effect.provide(layerAccount(instance, calls)));
});

it.effect("signs out and forgets the workspace when the instance rejects the session", () => {
  const instance: FakeInstance = {
    workspaceUrl: "https://o3-alice.tail.ts.net",
    sessionValid: false,
    meCalls: 0,
    tokenCalls: 0,
  };
  const calls: RegistryCalls = { registered: [], removed: [] };
  return Effect.gen(function* () {
    const account = yield* InstanceAccount;
    const failure = yield* account.refreshWorkspace.pipe(Effect.flip);
    expect(failure._tag).toBe("InstanceSignedOutError");
    expect(Option.isNone(yield* account.session)).toBe(true);
    expect(calls.removed).toEqual([environmentId]);
  }).pipe(Effect.provide(layerAccount(instance, calls)));
});
