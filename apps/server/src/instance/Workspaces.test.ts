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
  publish?: "tailnet" | "loopback";
  publishHost?: string;
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
            return {
              tailnetHostname:
                host.publish === "loopback" ? "127.0.0.1:41234" : `o3-${spec?.slug}.tail.ts.net`,
              ready: true,
            };
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
      runtime: {
        kind: "docker",
        socketPath: "/unused",
        network: "o3-test",
        publish: host.publish ?? "tailnet",
        publishHost: host.publishHost ?? null,
      },
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

it.effect.each([
  { publishHost: undefined, url: "http://127.0.0.1:41234", ws: "ws://127.0.0.1:41234" },
  {
    publishHost: "dev.tail.ts.net",
    url: "https://dev.tail.ts.net:41234",
    ws: "wss://dev.tail.ts.net:41234",
  },
])("publishes loopback workspaces with no tailnet device: $url", ({ publishHost, url, ws }) => {
  const host: FakeHost = {
    ...makeHost(),
    publish: "loopback",
    ...(publishHost ? { publishHost } : {}),
  };
  return Effect.gen(function* () {
    const workspaces = yield* Workspaces.Workspaces;
    const created = yield* workspaces.create({
      label: "Local",
      tools: [],
      limits: { cpus: 1, memoryMb: 1024, pids: 512 },
      memberUserIds: [],
    });
    yield* workspaces.drain;
    expect(host.mintedKeys).toBe(0);
    expect(host.created[0]?.tailscaleAuthKey).toBeNull();
    expect(Option.getOrThrow(yield* workspaces.get(created.id))).toMatchObject({
      status: "running",
      httpBaseUrl: url,
      wsBaseUrl: ws,
    });
    yield* workspaces.remove(created.id, true);
    expect(host.deletedDevices).toEqual([]);
  }).pipe(Effect.provide(layerWorkspaces(host)));
});
const bobId = InstanceUserId.make("user-bob");

const insertUser = (id: InstanceUserId = userId, name = "Alice") =>
  InstanceStore.InstanceStore.pipe(
    Effect.flatMap((store) =>
      store.insertUser({
        userId: id,
        email: `${name.toLowerCase()}@acme.test`,
        name,
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

const disableUser = (id: InstanceUserId) =>
  InstanceStore.InstanceStore.pipe(
    Effect.flatMap((store) =>
      store.updateUser(id, { disabledAt: "2026-01-02T00:00:00.000Z" }, "2026-01-02T00:00:00.000Z"),
    ),
  );

const limits = { cpus: 2, memoryMb: 2048, pids: 1024 };

it.effect("provisions, reconfigures, stops and removes a workspace", () => {
  const host = makeHost();
  return Effect.gen(function* () {
    const workspaces = yield* Workspaces.Workspaces;
    yield* insertUser();

    const unknownTools = yield* workspaces
      .create({ label: "Default", tools: ["claude", "cobol"], limits, memberUserIds: [] })
      .pipe(Effect.flip);
    expect(unknownTools._tag).toBe("InstanceBadRequestError");

    const provisioned = yield* workspaces.create({
      label: "Alice Smith",
      tools: ["uv", "claude", "uv"],
      limits,
      memberUserIds: [userId],
    });
    expect(provisioned).toMatchObject({ status: "provisioning", isDefault: false });
    expect(provisioned.members).toEqual([
      { userId, email: "alice@acme.test", name: "Alice", disabled: false, isDefault: true },
    ]);
    const workspaceId = provisioned.id;
    expect(workspaceId).not.toBe(userId);
    yield* workspaces.drain;

    expect(host.created).toHaveLength(1);
    const first = host.created[0]!;
    expect(first).toMatchObject({
      workspaceId,
      slug: "alice-smith",
      label: "Alice Smith",
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

    yield* workspaces.remove(workspaceId, true);
    expect(host.removedData).toEqual([workspaceId]);
    expect(host.deletedDevices).toEqual(["o3-alice-smith"]);
    expect(yield* workspaces.listForUser(userId)).toEqual([]);
  }).pipe(Effect.provide(layerWorkspaces(host)));
});

it.effect("shares workspaces between users, each with their own default", () => {
  const host = makeHost();
  return Effect.gen(function* () {
    const workspaces = yield* Workspaces.Workspaces;
    yield* insertUser();
    yield* insertUser(bobId, "Bob");
    const create = (label: string, memberUserIds: ReadonlyArray<string>) =>
      workspaces.create({ label, tools: [], limits, memberUserIds });
    const defaults = (id: InstanceUserId) =>
      workspaces
        .listForUser(id)
        .pipe(
          Effect.map((list) => list.map((workspace) => [workspace.label, workspace.isDefault])),
        );

    const main = yield* create("Main", [userId]);
    const team = yield* create("Team", [userId, bobId]);
    yield* workspaces.drain;
    expect(team.slug).toBe("team");
    expect(yield* defaults(userId)).toEqual([
      ["Main", true],
      ["Team", false],
    ]);
    expect(yield* defaults(bobId)).toEqual([["Team", true]]);
    // Labels are unique across the instance, not per user.
    expect((yield* create(" team ", [bobId]).pipe(Effect.flip))._tag).toBe("InstanceConflictError");
    expect((yield* workspaces.update(team.id, { label: "MAIN" }).pipe(Effect.flip))._tag).toBe(
      "InstanceConflictError",
    );

    // Separate containers, volumes, tailnet keys and secrets.
    const [mainSpec, teamSpec] = host.created;
    expect(teamSpec).toMatchObject({ workspaceId: team.id, slug: "team" });
    expect(host.mintedKeys).toBe(2);
    expect(yield* workspaces.verifySecret(team.id, teamSpec!.workspaceSecret)).toBe(true);
    expect(yield* workspaces.verifySecret(team.id, mainSpec!.workspaceSecret)).toBe(false);

    // Defaults are per user.
    yield* workspaces.setDefault(userId, team.id);
    expect(yield* defaults(userId)).toEqual([
      ["Team", true],
      ["Main", false],
    ]);
    expect((yield* workspaces.setDefault(bobId, main.id).pipe(Effect.flip))._tag).toBe(
      "InstanceNotFoundError",
    );

    // Leaving promotes the user's oldest remaining workspace; the workspace keeps running for Bob.
    const left = yield* workspaces.removeMember(team.id, userId);
    expect(left.members.map((member) => member.userId)).toEqual([bobId]);
    expect(left.status).toBe("running");
    expect(yield* defaults(userId)).toEqual([["Main", true]]);

    // Deleting a workspace promotes another default for each member.
    yield* workspaces.addMember(main.id, bobId);
    expect(yield* defaults(bobId)).toEqual([
      ["Team", true],
      ["Main", false],
    ]);
    yield* workspaces.remove(team.id, false);
    expect(yield* defaults(bobId)).toEqual([["Main", true]]);

    // A disabled member does not keep a shared workspace running; the last active one does.
    yield* disableUser(bobId);
    yield* workspaces.stopAllForUser(bobId);
    expect(Option.getOrThrow(yield* workspaces.get(main.id)).status).toBe("running");

    // Removing the last active member stops the workspace but keeps it.
    yield* workspaces.detachUser(userId);
    yield* workspaces.drain;
    const orphaned = yield* workspaces.getWithMembers(main.id);
    expect(orphaned).toMatchObject({
      status: "stopped",
      statusMessage: "Nobody active is on this workspace",
    });
    expect(orphaned.members.map((member) => [member.userId, member.disabled])).toEqual([
      [bobId, true],
    ]);
    expect(host.removedData).toEqual([]);

    // Disabled users can't join; adding an active one wakes the workspace up.
    expect((yield* workspaces.addMember(main.id, bobId).pipe(Effect.flip))._tag).toBe(
      "InstanceBadRequestError",
    );
    yield* workspaces.addMember(main.id, userId);
    yield* workspaces.drain;
    expect(Option.getOrThrow(yield* workspaces.get(main.id)).status).toBe("running");
    expect(yield* defaults(userId)).toEqual([["Main", true]]);
  }).pipe(Effect.provide(layerWorkspaces(host)));
});

it.effect("stopping a user's workspaces waits for a container still being created", () => {
  const host = makeHost();
  host.createGate = { entered: Deferred.makeUnsafe(), release: Deferred.makeUnsafe() };
  return Effect.gen(function* () {
    const workspaces = yield* Workspaces.Workspaces;
    yield* insertUser();
    const created = yield* workspaces.create({
      label: "Default",
      tools: [],
      limits,
      memberUserIds: [userId],
    });
    yield* Deferred.await(host.createGate!.entered);

    // The account is disabled while the runtime is still creating the container.
    yield* disableUser(userId);
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

it("derives DNS-safe slugs from the label", () => {
  const taken = new Set<string>();
  expect(Workspaces.workspaceSlug({ label: "Front End!", taken })).toBe("front-end");
  const long = Workspaces.workspaceSlug({
    label: "y".repeat(50),
    taken: new Set(["y".repeat(40)]),
  });
  expect(long).toBe(`${"y".repeat(38)}-2`);
  expect(long.length).toBeLessThanOrEqual(40);
  expect(Workspaces.workspaceSlug({ label: "🚀", taken })).toBe("workspace");
});
