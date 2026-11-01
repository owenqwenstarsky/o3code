import * as NodeServices from "@effect/platform-node/NodeServices";
import { InstanceUserId } from "@t3tools/contracts/instance";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { InstanceConfig } from "./InstanceConfig.ts";
import * as InstanceSettings from "./InstanceSettings.ts";
import * as InstanceStore from "./InstanceStore.ts";
import { TailscaleKeys } from "./TailscaleKeys.ts";
import { WorkspaceRuntime, type WorkspaceRuntimeSpec } from "./WorkspaceRuntime.ts";
import * as Workspaces from "./Workspaces.ts";

interface FakeHost {
  readonly created: Array<WorkspaceRuntimeSpec & { readonly containerId: string }>;
  readonly removedContainers: Array<string>;
  readonly removedData: Array<string>;
  readonly stopped: Array<string>;
  readonly deletedDevices: Array<string>;
  running: Set<string>;
  mintedKeys: number;
  /** When set, `create` reports it was reached and then waits for the gate. */
  createGate?: {
    readonly entered: Deferred.Deferred<void>;
    readonly release: Deferred.Deferred<void>;
  };
}

const makeHost = (): FakeHost => ({
  created: [],
  removedContainers: [],
  removedData: [],
  stopped: [],
  deletedDevices: [],
  running: new Set(),
  mintedKeys: 0,
});

const layerFakes = (host: FakeHost) =>
  Layer.mergeAll(
    Layer.succeed(
      WorkspaceRuntime,
      WorkspaceRuntime.of({
        kind: "docker",
        info: Effect.succeed({ version: "test", cpus: 8, memoryBytes: 1 }),
        create: (spec: WorkspaceRuntimeSpec) =>
          Effect.gen(function* () {
            if (host.createGate) {
              yield* Deferred.succeed(host.createGate.entered, undefined);
              yield* Deferred.await(host.createGate.release);
            }
            const containerId = `container-${host.created.length + 1}`;
            host.created.push({ ...spec, containerId });
            return containerId;
          }),
        start: (containerId: string) =>
          Effect.sync(() => {
            host.running.add(containerId);
          }),
        stop: (containerId: string) =>
          Effect.sync(() => {
            host.stopped.push(containerId);
            host.running.delete(containerId);
          }),
        restart: (containerId: string) =>
          Effect.sync(() => {
            host.running.add(containerId);
          }),
        removeContainer: (containerId: string) =>
          Effect.sync(() => {
            host.removedContainers.push(containerId);
            host.running.delete(containerId);
          }),
        removeData: (workspaceId: string) =>
          Effect.sync(() => {
            host.removedData.push(workspaceId);
          }),
        inspect: (containerId: string) =>
          Effect.sync(() =>
            Option.some({
              containerId,
              running: host.running.has(containerId),
              image: "o3code/workspace:test",
              detail: host.running.has(containerId) ? "running" : "exited",
            }),
          ),
        probe: (containerId: string) =>
          Effect.sync(() => {
            const spec = host.created.find((entry) => entry.containerId === containerId);
            return { tailnetHostname: `o3-${spec?.slug}.tail.ts.net`, ready: true };
          }),
        logs: () => Effect.succeed(""),
        diskUsage: Effect.succeed(new Map()),
      }),
    ),
    Layer.succeed(
      TailscaleKeys,
      TailscaleKeys.of({
        mode: "oauth",
        mintAuthKey: () =>
          Effect.sync(() => {
            host.mintedKeys += 1;
            return Redacted.make(`tskey-${host.mintedKeys}`);
          }),
        deleteDeviceByHostname: (hostname: string) =>
          Effect.sync(() => {
            host.deletedDevices.push(hostname);
          }),
      }),
    ),
    Layer.succeed(InstanceConfig, {
      initialName: "Acme",
      initialWorkspaceImage: "o3code/workspace:test",
      bootstrapAdmin: Option.none(),
      instanceUrl: Option.some("https://o3.tail.ts.net"),
      runtime: { kind: "docker", socketPath: "/unused", network: "o3-test" },
      tailscale: { mode: "none" },
      tailscaleTag: "tag:o3-workspace",
    }),
  );

const layerWorkspaces = (host: FakeHost) =>
  Workspaces.layer.pipe(
    Layer.provideMerge(InstanceSettings.layer),
    Layer.provideMerge(InstanceStore.layer),
    Layer.provideMerge(layerFakes(host)),
    Layer.provide(SqlitePersistence.layerMemory),
    Layer.provide(NodeServices.layer),
  );

const userId = InstanceUserId.make("user-alice");

const insertUser = InstanceStore.InstanceStore.pipe(
  Effect.flatMap((store) =>
    store.insertUser({
      userId,
      email: "alice@acme.test",
      name: "Alice",
      role: "member",
      passwordHash: "unused",
      mustChangePassword: false,
      disabledAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      lastLoginAt: null,
    }),
  ),
);

const limits = { cpus: 2, memoryMb: 2048, pids: 1024 };

it.effect("provisions, reconfigures, stops and removes a workspace", () => {
  const host = makeHost();
  return Effect.gen(function* () {
    const workspaces = yield* Workspaces.Workspaces;
    yield* insertUser;

    const unknownTools = yield* workspaces
      .create({
        userId,
        email: "alice@acme.test",
        label: "Default",
        tools: ["claude", "cobol"],
        limits,
      })
      .pipe(Effect.flip);
    expect(unknownTools._tag).toBe("InstanceBadRequestError");

    const provisioned = yield* workspaces.create({
      userId,
      email: "Alice.Smith@acme.test",
      label: "Default",
      tools: ["uv", "claude", "uv"],
      limits,
    });
    expect(provisioned).toMatchObject({ status: "provisioning", isDefault: true });
    const workspaceId = provisioned.id;
    expect(workspaceId).not.toBe(userId);
    yield* workspaces.drain;

    expect(host.created).toHaveLength(1);
    const first = host.created[0]!;
    expect(first).toMatchObject({
      workspaceId,
      userId,
      slug: "alice-smith",
      tools: ["claude", "uv"],
      instanceUrl: "https://o3.tail.ts.net",
      tailscaleTag: "tag:o3-workspace",
    });
    expect(first.tailscaleAuthKey && Redacted.value(first.tailscaleAuthKey)).toBe("tskey-1");
    const running = Option.getOrThrow(yield* workspaces.get(workspaceId));
    expect(running).toMatchObject({
      status: "running",
      tailnetHostname: "o3-alice-smith.tail.ts.net",
      httpBaseUrl: "https://o3-alice-smith.tail.ts.net",
      wsBaseUrl: "wss://o3-alice-smith.tail.ts.net",
    });
    expect(yield* workspaces.verifySecret(workspaceId, first.workspaceSecret)).toBe(true);
    expect(yield* workspaces.verifySecret(userId, first.workspaceSecret)).toBe(false);
    expect(yield* workspaces.verifySecret(workspaceId, "guess")).toBe(false);

    // Tools apply at container creation, so changing them recreates the container.
    yield* workspaces.update(workspaceId, { tools: ["codex"] });
    yield* workspaces.drain;
    expect(host.created).toHaveLength(2);
    const second = host.created[1]!;
    expect(second.tools).toEqual(["codex"]);
    expect(host.removedContainers).toContain(first.containerId);
    // A recreated container gets a new secret; the old one stops working.
    expect(yield* workspaces.verifySecret(workspaceId, first.workspaceSecret)).toBe(false);
    expect(yield* workspaces.verifySecret(workspaceId, second.workspaceSecret)).toBe(true);

    // An update that changes nothing, or only the label, leaves the container alone.
    yield* workspaces.update(workspaceId, { tools: ["codex"], limits });
    yield* workspaces.update(workspaceId, { label: "Main" });
    yield* workspaces.drain;
    expect(host.created).toHaveLength(2);
    expect(Option.getOrThrow(yield* workspaces.get(workspaceId)).label).toBe("Main");

    yield* workspaces.action(workspaceId, "stop");
    yield* workspaces.drain;
    expect(host.stopped).toEqual([second.containerId]);
    expect(Option.getOrThrow(yield* workspaces.get(workspaceId)).status).toBe("stopped");

    // The last workspace goes only with its user.
    const lastOne = yield* workspaces.remove(workspaceId, true).pipe(Effect.flip);
    expect(lastOne._tag).toBe("InstanceBadRequestError");
    yield* workspaces.removeAllForUser(userId, true);
    expect(host.removedData).toEqual([workspaceId]);
    expect(host.deletedDevices).toEqual(["o3-alice-smith"]);
    expect(yield* workspaces.listForUser(userId)).toEqual([]);
  }).pipe(Effect.provide(layerWorkspaces(host)));
});

it.effect("keeps a user's workspaces apart and one of them the default", () => {
  const host = makeHost();
  return Effect.gen(function* () {
    const workspaces = yield* Workspaces.Workspaces;
    yield* insertUser;
    const create = (label: string) =>
      workspaces.create({ userId, email: "alice@acme.test", label, tools: [], limits });

    const main = yield* create("Default");
    const frontend = yield* create("Frontend");
    yield* workspaces.drain;
    expect(frontend).toMatchObject({ slug: "alice-frontend", isDefault: false });
    expect((yield* create(" frontend ").pipe(Effect.flip))._tag).toBe("InstanceConflictError");
    expect(
      (yield* workspaces.update(frontend.id, { label: "DEFAULT" }).pipe(Effect.flip))._tag,
    ).toBe("InstanceConflictError");

    // Separate containers, volumes, tailnet keys and secrets.
    const [mainSpec, frontendSpec] = host.created;
    expect(frontendSpec).toMatchObject({ workspaceId: frontend.id, slug: "alice-frontend" });
    expect(host.mintedKeys).toBe(2);
    expect(yield* workspaces.verifySecret(frontend.id, frontendSpec!.workspaceSecret)).toBe(true);
    expect(yield* workspaces.verifySecret(frontend.id, mainSpec!.workspaceSecret)).toBe(false);

    yield* workspaces.action(frontend.id, "stop");
    yield* workspaces.drain;
    expect(host.stopped).toEqual([frontendSpec!.containerId]);
    expect(Option.getOrThrow(yield* workspaces.get(main.id)).status).toBe("running");

    yield* workspaces.setDefault(frontend.id);
    expect((yield* workspaces.listForUser(userId)).map((workspace) => workspace.id)).toEqual([
      frontend.id,
      main.id,
    ]);
    expect(Option.getOrThrow(yield* workspaces.get(main.id)).isDefault).toBe(false);

    // Removing the default promotes the oldest remaining workspace.
    const backend = yield* create("Backend");
    yield* workspaces.drain;
    yield* workspaces.remove(frontend.id, true);
    expect(host.removedData).toEqual([frontend.id]);
    expect(host.deletedDevices).toEqual(["o3-alice-frontend"]);
    expect(
      (yield* workspaces.listForUser(userId)).map((workspace) => [
        workspace.id,
        workspace.isDefault,
      ]),
    ).toEqual([
      [main.id, true],
      [backend.id, false],
    ]);

    yield* workspaces.stopAllForUser(userId);
    expect(
      (yield* workspaces.listForUser(userId)).every((workspace) => workspace.status === "stopped"),
    ).toBe(true);
    yield* workspaces.startAllForUser(userId);
    yield* workspaces.drain;
    expect(
      (yield* workspaces.listForUser(userId)).every((workspace) => workspace.status === "running"),
    ).toBe(true);
  }).pipe(Effect.provide(layerWorkspaces(host)));
});

it.effect("stopping a user's workspaces waits for a container still being created", () => {
  const host = makeHost();
  host.createGate = { entered: Deferred.makeUnsafe(), release: Deferred.makeUnsafe() };
  return Effect.gen(function* () {
    const workspaces = yield* Workspaces.Workspaces;
    yield* insertUser;
    const created = yield* workspaces.create({
      userId,
      email: "alice@acme.test",
      label: "Default",
      tools: [],
      limits,
    });
    yield* Deferred.await(host.createGate!.entered);

    // The account is disabled while the runtime is still creating the container.
    const stopping = yield* Effect.forkChild(workspaces.stopAllForUser(userId));
    yield* Deferred.succeed(host.createGate!.release, undefined);
    yield* Fiber.join(stopping);
    yield* workspaces.drain;

    expect(host.running.size).toBe(0);
    expect(host.stopped).toEqual([host.created[0]!.containerId]);
    expect(Option.getOrThrow(yield* workspaces.get(created.id))).toMatchObject({
      status: "stopped",
      statusMessage: "Account disabled",
    });
  }).pipe(Effect.provide(layerWorkspaces(host)));
});

it("derives DNS-safe slugs from the email and label", () => {
  const taken = new Set<string>();
  expect(
    Workspaces.workspaceSlug({ email: "a.b@x.test", label: "Default", first: true, taken }),
  ).toBe("a-b");
  expect(
    Workspaces.workspaceSlug({ email: "a.b@x.test", label: "Front End!", first: false, taken }),
  ).toBe("a-b-front-end");
  const long = Workspaces.workspaceSlug({
    email: `${"x".repeat(30)}@x.test`,
    label: "y".repeat(40),
    first: false,
    taken: new Set([`${"x".repeat(24)}-${"y".repeat(15)}`]),
  });
  expect(long).toBe(`${"x".repeat(24)}-${"y".repeat(13)}-2`);
  expect(long.length).toBeLessThanOrEqual(40);
  expect(Workspaces.workspaceSlug({ email: "ab@x.test", label: "🚀", first: false, taken })).toBe(
    "ab-workspace",
  );
});
