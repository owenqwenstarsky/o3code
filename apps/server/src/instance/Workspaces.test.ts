import * as NodeServices from "@effect/platform-node/NodeServices";
import { InstanceUserId } from "@t3tools/contracts/instance";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
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
        create: Effect.fn("FakeRuntime.create")(function* (spec: WorkspaceRuntimeSpec) {
          const containerId = `container-${host.created.length + 1}`;
          host.created.push({ ...spec, containerId });
          return containerId;
        }),
        start: Effect.fn("FakeRuntime.start")(function* (containerId: string) {
          host.running.add(containerId);
        }),
        stop: Effect.fn("FakeRuntime.stop")(function* (containerId: string) {
          host.stopped.push(containerId);
          host.running.delete(containerId);
        }),
        restart: Effect.fn("FakeRuntime.restart")(function* (containerId: string) {
          host.running.add(containerId);
        }),
        removeContainer: Effect.fn("FakeRuntime.removeContainer")(function* (containerId: string) {
          host.removedContainers.push(containerId);
          host.running.delete(containerId);
        }),
        removeData: Effect.fn("FakeRuntime.removeData")(function* (userId: string) {
          host.removedData.push(userId);
        }),
        inspect: Effect.fn("FakeRuntime.inspect")(function* (containerId: string) {
          return Option.some({
            containerId,
            running: host.running.has(containerId),
            image: "o3code/workspace:test",
            detail: host.running.has(containerId) ? "running" : "exited",
          });
        }),
        probe: Effect.fn("FakeRuntime.probe")(function* (containerId: string) {
          const spec = host.created.find((entry) => entry.containerId === containerId);
          return { tailnetHostname: `o3-${spec?.slug}.tail.ts.net`, ready: true };
        }),
        logs: Effect.fn("FakeRuntime.logs")(function* () {
          return "";
        }),
        diskUsage: Effect.succeed(new Map()),
      }),
    ),
    Layer.succeed(
      TailscaleKeys,
      TailscaleKeys.of({
        mode: "oauth",
        mintAuthKey: Effect.fn("FakeTailscale.mintAuthKey")(function* () {
          host.mintedKeys += 1;
          return Redacted.make(`tskey-${host.mintedKeys}`);
        }),
        deleteDeviceByHostname: Effect.fn("FakeTailscale.deleteDevice")(function* (
          hostname: string,
        ) {
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
      .provision({ userId, email: "alice@acme.test", tools: ["claude", "cobol"], limits })
      .pipe(Effect.flip);
    expect(unknownTools._tag).toBe("InstanceBadRequestError");

    const provisioned = yield* workspaces.provision({
      userId,
      email: "Alice.Smith@acme.test",
      tools: ["uv", "claude", "uv"],
      limits,
    });
    expect(provisioned.status).toBe("provisioning");
    yield* workspaces.drain;

    expect(host.created).toHaveLength(1);
    const first = host.created[0]!;
    expect(first).toMatchObject({
      slug: "alice-smith",
      tools: ["claude", "uv"],
      instanceUrl: "https://o3.tail.ts.net",
      tailscaleTag: "tag:o3-workspace",
    });
    expect(first.tailscaleAuthKey && Redacted.value(first.tailscaleAuthKey)).toBe("tskey-1");
    const running = Option.getOrThrow(yield* workspaces.get(userId));
    expect(running).toMatchObject({
      status: "running",
      tailnetHostname: "o3-alice-smith.tail.ts.net",
      httpBaseUrl: "https://o3-alice-smith.tail.ts.net",
      wsBaseUrl: "wss://o3-alice-smith.tail.ts.net",
    });
    expect(yield* workspaces.verifySecret(userId, first.workspaceSecret)).toBe(true);
    expect(yield* workspaces.verifySecret(userId, "guess")).toBe(false);

    // Tools apply at container creation, so changing them recreates the container.
    yield* workspaces.update(userId, { tools: ["codex"] });
    yield* workspaces.drain;
    expect(host.created).toHaveLength(2);
    const second = host.created[1]!;
    expect(second.tools).toEqual(["codex"]);
    expect(host.removedContainers).toContain(first.containerId);
    // A recreated container gets a new secret; the old one stops working.
    expect(yield* workspaces.verifySecret(userId, first.workspaceSecret)).toBe(false);
    expect(yield* workspaces.verifySecret(userId, second.workspaceSecret)).toBe(true);

    // An update that changes nothing leaves the container alone.
    yield* workspaces.update(userId, { tools: ["codex"], limits });
    yield* workspaces.drain;
    expect(host.created).toHaveLength(2);

    yield* workspaces.action(userId, "stop");
    yield* workspaces.drain;
    expect(host.stopped).toEqual([second.containerId]);
    expect(Option.getOrThrow(yield* workspaces.get(userId)).status).toBe("stopped");

    yield* workspaces.remove(userId, true);
    expect(host.removedData).toEqual([userId]);
    expect(host.deletedDevices).toEqual(["o3-alice-smith"]);
  }).pipe(Effect.provide(layerWorkspaces(host)));
});
