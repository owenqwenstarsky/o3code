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

interface FakeWorkspace {
  id: string;
  label: string;
  isDefault: boolean;
  status: "running" | "stopped";
  url: string;
  /** What the workspace's own server reports. */
  environmentId: string;
}

interface FakeInstance {
  workspaces: Array<FakeWorkspace>;
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

const toView = (workspace: FakeWorkspace) => ({
  id: workspace.id,
  userId: "user-1",
  label: workspace.label,
  isDefault: workspace.isDefault,
  slug: workspace.id,
  status: workspace.status,
  statusMessage: workspace.status === "running" ? null : "Stopped",
  tailnetHostname: new URL(workspace.url).host,
  httpBaseUrl: workspace.url,
  wsBaseUrl: workspace.url.replace(/^http/, "ws"),
  image: "o3code/workspace:test",
  tools: [],
  limits: { cpus: 2, memoryMb: 2048, pids: 1024 },
  diskUsageBytes: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const mainWorkspace = (overrides: Partial<FakeWorkspace> = {}): FakeWorkspace => ({
  id: "ws-main",
  label: "Default",
  isDefault: true,
  status: "running",
  url: "https://o3-alice.tail.ts.net",
  environmentId,
  ...overrides,
});

const layerFakeHttp = (instance: FakeInstance) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        const url = new URL(request.url);
        const json = (body: unknown, status = 200) =>
          HttpClientResponse.fromWeb(request, Response.json(body, { status }));
        const views = instance.workspaces
          .toSorted((left, right) => Number(right.isDefault) - Number(left.isDefault))
          .map(toView);
        if (url.pathname === "/o3/api/auth/me") {
          instance.meCalls += 1;
          return instance.sessionValid
            ? json({ user, workspace: views[0] ?? null, workspaces: views, sessionId: "session-1" })
            : json(
                {
                  _tag: "InstanceUnauthorizedError",
                  reason: "session_expired",
                  message: "Your session has ended.",
                },
                401,
              );
        }
        const token = /^\/o3\/api\/workspaces\/([^/]+)\/token$/.exec(url.pathname);
        if (token) {
          instance.tokenCalls += 1;
          return json({
            token: `o3w_token-${instance.tokenCalls}`,
            expiresAt: "2099-01-01T00:00:00.000Z",
            workspace: views.find((view) => view.id === token[1]),
          });
        }
        if (url.pathname === "/.well-known/t3/environment") {
          const workspace = instance.workspaces.find(
            (candidate) => new URL(candidate.url).host === url.host,
          );
          return json({
            environmentId: workspace?.environmentId,
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
};

const withMain: StoredInstanceSession = {
  ...signedIn,
  workspaces: [
    {
      workspaceId: "ws-main",
      environmentId,
      httpBaseUrl: "https://o3-alice.tail.ts.net",
      tokenExpiresAt: "2099-01-01T00:00:00.000Z",
      isDefault: true,
    },
  ],
};

const layerAccount = (
  instance: FakeInstance,
  calls: RegistryCalls,
  initial: StoredInstanceSession = withMain,
) =>
  layerInstanceAccount.pipe(
    Layer.provideMerge(layerSessionStore(initial)),
    Layer.provide(layerFakeRegistry(calls)),
    Layer.provide(layerFakeHttp(instance)),
  );

const registeredAs = (calls: RegistryCalls) =>
  calls.registered.map((registration) => [
    registration.target.connectionId,
    registration.target.label,
  ]);

it.effect("re-registers the workspace when its address changes, even with a fresh token", () => {
  const instance: FakeInstance = {
    workspaces: [mainWorkspace()],
    sessionValid: true,
    meCalls: 0,
    tokenCalls: 0,
  };
  const calls: RegistryCalls = { registered: [], removed: [] };
  return Effect.gen(function* () {
    const account = yield* InstanceAccount;

    yield* account.refreshWorkspaces;
    expect(instance.meCalls).toBe(1);
    expect(calls.registered).toHaveLength(0);

    instance.workspaces[0]!.url = "https://o3-alice-1.tail.ts.net";
    yield* account.refreshWorkspaces;
    expect(instance.tokenCalls).toBe(1);
    expect(calls.registered.map((registration) => registration.profile.httpBaseUrl)).toEqual([
      "https://o3-alice-1.tail.ts.net",
    ]);
    const session = Option.getOrThrow(yield* account.session);
    expect(session.workspaces?.[0]?.httpBaseUrl).toBe("https://o3-alice-1.tail.ts.net");
  }).pipe(Effect.provide(layerAccount(instance, calls)));
});

it.effect("signs out and forgets the workspace when the instance rejects the session", () => {
  const instance: FakeInstance = {
    workspaces: [mainWorkspace()],
    sessionValid: false,
    meCalls: 0,
    tokenCalls: 0,
  };
  const calls: RegistryCalls = { registered: [], removed: [] };
  return Effect.gen(function* () {
    const account = yield* InstanceAccount;
    const failure = yield* account.refreshWorkspaces.pipe(Effect.flip);
    expect(failure._tag).toBe("InstanceSignedOutError");
    expect(Option.isNone(yield* account.session)).toBe(true);
    expect(calls.removed).toEqual([environmentId]);
  }).pipe(Effect.provide(layerAccount(instance, calls)));
});

it.effect("registers every running workspace and follows the default", () => {
  const frontendEnvironmentId = EnvironmentId.make("frontend-env");
  const instance: FakeInstance = {
    workspaces: [
      mainWorkspace(),
      {
        id: "ws-frontend",
        label: "Frontend",
        isDefault: false,
        status: "running",
        url: "https://o3-alice-frontend.tail.ts.net",
        environmentId: frontendEnvironmentId,
      },
      {
        id: "ws-stopped",
        label: "Stopped",
        isDefault: false,
        status: "stopped",
        url: "https://o3-alice-stopped.tail.ts.net",
        environmentId: "stopped-env",
      },
    ],
    sessionValid: true,
    meCalls: 0,
    tokenCalls: 0,
  };
  const calls: RegistryCalls = { registered: [], removed: [] };
  return Effect.gen(function* () {
    const account = yield* InstanceAccount;

    // A stopped extra workspace doesn't fail the connect.
    const connected = yield* account.connectWorkspaces;
    expect(connected.id).toBe("ws-main");
    expect(registeredAs(calls)).toEqual([
      ["o3:default:workspace-env", "Default"],
      ["o3:frontend-env", "Frontend"],
    ]);
    const session = Option.getOrThrow(yield* account.session);
    expect(session.workspaces?.map((entry) => [entry.workspaceId, entry.isDefault])).toEqual([
      ["ws-main", true],
      ["ws-frontend", false],
    ]);

    // Nothing changed, so nothing is re-minted.
    yield* account.refreshWorkspaces;
    expect(calls.registered).toHaveLength(2);

    // A new default re-registers both, so the home environment moves.
    instance.workspaces[0]!.isDefault = false;
    instance.workspaces[1]!.isDefault = true;
    calls.registered.length = 0;
    yield* account.refreshWorkspaces;
    expect(registeredAs(calls)).toEqual([
      ["o3:default:frontend-env", "Frontend"],
      ["o3:workspace-env", "Default"],
    ]);

    // A workspace removed on the instance is forgotten here.
    instance.workspaces = instance.workspaces.filter((workspace) => workspace.id !== "ws-main");
    yield* account.refreshWorkspaces;
    expect(calls.removed).toEqual([environmentId]);
    expect(
      Option.getOrThrow(yield* account.session).workspaces?.map((entry) => entry.workspaceId),
    ).toEqual(["ws-frontend"]);
  }).pipe(Effect.provide(layerAccount(instance, calls, signedIn)));
});

it.effect("registers workspaces that report the same environment once", () => {
  const instance: FakeInstance = {
    workspaces: [
      mainWorkspace({ url: "https://workspace.test" }),
      mainWorkspace({
        id: "ws-2",
        label: "Second",
        isDefault: false,
        url: "https://workspace.test",
      }),
    ],
    sessionValid: true,
    meCalls: 0,
    tokenCalls: 0,
  };
  const calls: RegistryCalls = { registered: [], removed: [] };
  return Effect.gen(function* () {
    const account = yield* InstanceAccount;
    yield* account.connectWorkspaces;
    expect(registeredAs(calls)).toEqual([["o3:default:workspace-env", "Default"]]);
  }).pipe(Effect.provide(layerAccount(instance, calls, signedIn)));
});

it.effect("moves a session saved by an older client to the workspace list", () => {
  const legacyEnvironmentId = EnvironmentId.make("legacy-env");
  const instance: FakeInstance = {
    workspaces: [mainWorkspace()],
    sessionValid: true,
    meCalls: 0,
    tokenCalls: 0,
  };
  const calls: RegistryCalls = { registered: [], removed: [] };
  return Effect.gen(function* () {
    const account = yield* InstanceAccount;
    yield* account.refreshWorkspaces;
    expect(registeredAs(calls)).toEqual([["o3:default:workspace-env", "Default"]]);
    expect(calls.removed).toEqual([legacyEnvironmentId]);
    const session = Option.getOrThrow(yield* account.session);
    expect(session.environmentId).toBeUndefined();
    expect(session.workspaces?.map((entry) => entry.environmentId)).toEqual([environmentId]);
  }).pipe(
    Effect.provide(
      layerAccount(instance, calls, { ...signedIn, environmentId: legacyEnvironmentId }),
    ),
  );
});
