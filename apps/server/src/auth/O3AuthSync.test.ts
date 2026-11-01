import * as NodeServices from "@effect/platform-node/NodeServices";
import type { InstanceAuthSyncProvider } from "@t3tools/contracts/instance";
import { expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ServerConfig from "../config.ts";
import * as O3AuthSync from "./O3AuthSync.ts";

const { contentHash, planProviderSync } = O3AuthSync;

it("plans each provider's step", () => {
  const synced = (content: string | null, version: number) => ({
    version,
    hash: contentHash(content),
  });
  const cases: ReadonlyArray<[string, Parameters<typeof planProviderSync>[0], unknown]> = [
    [
      "joining adopts the group's copy and backs up a different local one",
      { local: "mine", synced: undefined, remote: { version: 4, content: "group" } },
      { kind: "apply", version: 4, content: "group", backup: true },
    ],
    [
      "joining a group with no copy offers the local one",
      { local: "mine", synced: undefined, remote: undefined },
      { kind: "push", baseVersion: 0, content: "mine" },
    ],
    [
      "nothing on either side does nothing",
      { local: null, synced: undefined, remote: undefined },
      { kind: "none" },
    ],
    [
      "a local refresh is pushed from the version it was based on",
      { local: "new", synced: synced("old", 2), remote: { version: 2 } },
      { kind: "push", baseVersion: 2, content: "new" },
    ],
    [
      "a local sign-out is pushed",
      { local: null, synced: synced("old", 2), remote: { version: 2 } },
      { kind: "push", baseVersion: 2, content: null },
    ],
    [
      "a newer group copy wins over a local change",
      { local: "new", synced: synced("old", 2), remote: { version: 3, content: "theirs" } },
      { kind: "apply", version: 3, content: "theirs", backup: false },
    ],
    [
      "an unchanged file at the current version does nothing",
      { local: "same", synced: synced("same", 2), remote: { version: 2 } },
      { kind: "none" },
    ],
  ];
  for (const [name, input, expected] of cases) {
    expect(planProviderSync(input), name).toEqual(expected);
  }
});

interface FakeGroup {
  groupId: string | null;
  files: Map<InstanceAuthSyncProvider, { version: number; content: string | null }>;
  pushes: number;
}

const decoder = new TextDecoder();

/** Answers pull and push like the instance, for one workspace in one group. */
const layerFakeInstance = (group: FakeGroup) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        const body: unknown =
          request.body._tag === "Uint8Array" ? JSON.parse(decoder.decode(request.body.body)) : {};
        const json = (value: unknown) => HttpClientResponse.fromWeb(request, Response.json(value));
        const { pathname } = new URL(request.url);
        if (pathname.endsWith("/auth-sync/pull")) {
          const known = (body as { known: Array<{ provider: string; version: number }> }).known;
          return json({
            groupId: group.groupId,
            files:
              group.groupId === null
                ? []
                : [...group.files].map(([provider, file]) => {
                    const knownVersion = known.find((k) => k.provider === provider)?.version ?? 0;
                    return file.version > knownVersion
                      ? { provider, version: file.version, content: file.content }
                      : { provider, version: file.version };
                  }),
          });
        }
        const push = body as {
          provider: InstanceAuthSyncProvider;
          baseVersion: number;
          content: string | null;
        };
        group.pushes += 1;
        const existing = group.files.get(push.provider);
        if ((existing?.version ?? 0) !== push.baseVersion) {
          return json({
            groupId: group.groupId,
            accepted: false,
            current: { provider: push.provider, ...(existing ?? { version: 0, content: null }) },
          });
        }
        const next = { version: push.baseVersion + 1, content: push.content };
        group.files.set(push.provider, next);
        return json({
          groupId: group.groupId,
          accepted: true,
          current: { provider: push.provider, ...next },
        });
      }),
    ),
  );

const credential = (token: string) => JSON.stringify({ token });

it.effect("keeps the agent sign-ins in a workspace's home in step with its group", () => {
  const group: FakeGroup = {
    groupId: "group-1",
    files: new Map([["claude", { version: 1, content: credential("group") }]]),
    pushes: 0,
  };
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "o3-auth-sync-home-" });
    const claude = path.join(home, ".claude/.credentials.json");
    const codex = path.join(home, ".codex/auth.json");
    const settings = path.join(home, ".claude/settings.json");
    yield* fs.makeDirectory(path.dirname(claude), { recursive: true });
    yield* fs.makeDirectory(path.dirname(codex), { recursive: true });
    yield* fs.writeFileString(claude, credential("mine"));
    yield* fs.writeFileString(codex, credential("codex-mine"));
    yield* fs.writeFileString(settings, "{}");

    const syncer = O3AuthSync.make.pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: {
              T3CODE_O3_INSTANCE_URL: "http://instance.test",
              T3CODE_O3_WORKSPACE_ID: "ws-1",
              T3CODE_O3_WORKSPACE_SECRET: "secret",
              HOME: home,
            },
          }),
        ),
      ),
      Effect.map(Option.getOrThrow),
    );
    const tick = yield* syncer;

    // Joining adopts the group's Claude sign-in, keeps the old one, and offers Codex's.
    yield* tick;
    expect(yield* fs.readFileString(claude)).toBe(credential("group"));
    expect(yield* fs.readFileString(`${claude}.o3-before-sync`)).toBe(credential("mine"));
    expect(((yield* fs.stat(claude)).mode & 0o777).toString(8)).toBe("600");
    expect(group.files.get("codex")).toEqual({ version: 1, content: credential("codex-mine") });

    // A refresh here reaches the group; a half-written file does not.
    yield* fs.writeFileString(claude, credential("refreshed"));
    yield* tick;
    expect(group.files.get("claude")).toEqual({ version: 2, content: credential("refreshed") });
    yield* fs.writeFileString(claude, '{"tok');
    const pushes = group.pushes;
    yield* tick;
    expect(group.pushes).toBe(pushes);
    yield* fs.writeFileString(claude, credential("refreshed"));

    // A refresh elsewhere lands here, and survives a restart without being re-applied.
    group.files.set("claude", { version: 3, content: credential("theirs") });
    yield* tick;
    expect(yield* fs.readFileString(claude)).toBe(credential("theirs"));
    const restarted = yield* syncer;
    yield* restarted;
    expect(group.pushes).toBe(pushes);

    // Signing out here signs the group out.
    yield* fs.remove(claude);
    yield* restarted;
    expect(group.files.get("claude")).toEqual({ version: 4, content: null });

    // Leaving keeps the private copies; nothing else in the home is ever touched.
    group.groupId = null;
    yield* restarted;
    expect(yield* fs.readFileString(codex)).toBe(credential("codex-mine"));
    expect(yield* fs.readFileString(settings)).toBe("{}");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        layerFakeInstance(group),
        ServerConfig.layerTest(process.cwd(), { prefix: "o3-auth-sync-state-" }),
      ).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
  );
});
