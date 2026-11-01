// @effect-diagnostics nodeBuiltinImport:off -- Effect's Crypto has no synchronous sha256 for file hashes.
import * as NodeCrypto from "node:crypto";

import { ProviderDriverKind } from "@t3tools/contracts";
import {
  InstanceAuthSyncProvider,
  InstanceHttpApi,
  STATIC_WORKSPACE_ID,
  type InstanceAuthSyncPullResult,
} from "@t3tools/contracts/instance";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { FetchHttpClient } from "effect/http";
import * as HttpApiClient from "effect/http-api/HttpApiClient";

import * as ServerConfig from "../config.ts";
import { ProviderRegistry } from "../provider/ProviderRegistry.ts";

const SYNC_INTERVAL = "5 seconds";
const STATE_FILE = "o3-auth-sync.json";
const BACKUP_SUFFIX = ".o3-before-sync";

/** Each agent CLI's credential file, relative to the workspace's home. Nothing else is synced. */
const AUTH_SYNC_FILES: Record<InstanceAuthSyncProvider, string> = {
  claude: ".claude/.credentials.json",
  codex: ".codex/auth.json",
  grok: ".grok/auth.json",
  opencode: ".local/share/opencode/auth.json",
};

const PROVIDERS = InstanceAuthSyncProvider.literals;

/** The provider driver whose sign-in status reads each credential file. */
const DRIVER_KINDS: Record<InstanceAuthSyncProvider, ProviderDriverKind> = {
  claude: ProviderDriverKind.make("claudeAgent"),
  codex: ProviderDriverKind.make("codex"),
  grok: ProviderDriverKind.make("grok"),
  opencode: ProviderDriverKind.make("opencode"),
};

/** The group version this workspace last applied or pushed, and the file contents at that time. */
export interface SyncedFile {
  readonly version: number;
  readonly hash: string;
}

export type ProviderSyncPlan =
  | { readonly kind: "none" }
  | { readonly kind: "push"; readonly baseVersion: number; readonly content: string | null }
  | {
      readonly kind: "apply";
      readonly version: number;
      readonly content: string | null;
      readonly backup: boolean;
    };

/** Every synced credential file is a JSON object; anything else is a CLI caught mid-write. */
const decodeCredential = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const isCompleteCredential = (content: string) => Option.isSome(decodeCredential(content));

export const contentHash = (content: string | null) =>
  content === null ? "absent" : NodeCrypto.createHash("sha256").update(content).digest("base64url");

/**
 * Decides one provider's step. A newer group copy wins over a local change, so a group converges
 * on one credential; a workspace joining a group adopts the group's copy and keeps a backup.
 */
export const planProviderSync = (input: {
  readonly local: string | null;
  readonly synced: SyncedFile | undefined;
  readonly remote: { readonly version: number; readonly content?: string | null } | undefined;
}): ProviderSyncPlan => {
  const remoteVersion = input.remote?.version ?? 0;
  const remoteContent = input.remote?.content;
  if (input.synced === undefined) {
    if (remoteVersion > 0 && remoteContent !== undefined) {
      return {
        kind: "apply",
        version: remoteVersion,
        content: remoteContent,
        backup: input.local !== null && input.local !== remoteContent,
      };
    }
    return input.local === null
      ? { kind: "none" }
      : { kind: "push", baseVersion: remoteVersion, content: input.local };
  }
  if (remoteVersion > input.synced.version && remoteContent !== undefined) {
    return { kind: "apply", version: remoteVersion, content: remoteContent, backup: false };
  }
  return contentHash(input.local) === input.synced.hash
    ? { kind: "none" }
    : { kind: "push", baseVersion: remoteVersion, content: input.local };
};

const SyncState = Schema.Struct({
  groupId: Schema.NullOr(Schema.String),
  files: Schema.Record(Schema.String, Schema.Struct({ version: Schema.Int, hash: Schema.String })),
});
type SyncState = typeof SyncState.Type;
const SyncStateJson = Schema.fromJsonString(SyncState);
const decodeState = Schema.decodeUnknownEffect(SyncStateJson);
const encodeState = Schema.encodeEffect(SyncStateJson);
const EMPTY_STATE: SyncState = { groupId: null, files: {} };
const sameState = (left: SyncState, right: SyncState) =>
  left.groupId === right.groupId &&
  PROVIDERS.every(
    (provider) =>
      left.files[provider]?.version === right.files[provider]?.version &&
      left.files[provider]?.hash === right.files[provider]?.hash,
  );

const O3AuthSyncConfig = Config.all({
  instanceUrl: Config.String("T3CODE_O3_INSTANCE_URL").pipe(Config.option),
  workspaceId: Config.String("T3CODE_O3_WORKSPACE_ID").pipe(Config.option),
  secret: Config.Redacted("T3CODE_O3_WORKSPACE_SECRET").pipe(Config.option),
  home: Config.String("HOME").pipe(Config.option),
});

/**
 * One sync pass, returning the providers whose credential file it rewrote, or none outside a
 * workspace an O3 instance manages. The dev stand-in never syncs: it uses the developer's home.
 */
export const make = Effect.gen(function* () {
  const config = yield* O3AuthSyncConfig;
  if (
    Option.isNone(config.instanceUrl) ||
    Option.isNone(config.workspaceId) ||
    Option.isNone(config.secret) ||
    Option.isNone(config.home) ||
    config.workspaceId.value === STATIC_WORKSPACE_ID
  ) {
    return Option.none();
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const home = config.home.value;
  const statePath = path.join(stateDir, STATE_FILE);
  const headers = {
    authorization: `Bearer ${config.workspaceId.value}:${Redacted.value(config.secret.value)}`,
  };
  const client = yield* HttpApiClient.make(InstanceHttpApi, {
    baseUrl: config.instanceUrl.value.replace(/\/+$/, ""),
  });

  const initial = yield* fs.readFileString(statePath).pipe(
    Effect.flatMap(decodeState),
    Effect.orElseSucceed(() => EMPTY_STATE),
  );
  const state = yield* Ref.make(initial);

  const fileFor = (provider: InstanceAuthSyncProvider) =>
    path.join(home, AUTH_SYNC_FILES[provider]);

  const readLocal = (file: string) =>
    fs
      .exists(file)
      .pipe(Effect.flatMap((exists) => (exists ? fs.readFileString(file) : Effect.succeed(null))));

  const writeLocal = Effect.fn("O3AuthSync.writeLocal")(function* (
    file: string,
    content: string | null,
  ) {
    if (content === null) {
      yield* fs.remove(file, { force: true });
      return;
    }
    yield* fs.makeDirectory(path.dirname(file), { recursive: true, mode: 0o700 });
    // Replace in one rename so a CLI never reads a half-written credential.
    const temporary = `${file}.o3-sync-${NodeCrypto.randomBytes(6).toString("hex")}`;
    yield* fs.writeFileString(temporary, content, { mode: 0o600 });
    yield* fs.rename(temporary, file);
  });

  const save = (next: SyncState) =>
    encodeState(next).pipe(
      Effect.flatMap((json) => fs.writeFileString(statePath, json, { mode: 0o600 })),
      Effect.andThen(Ref.set(state, next)),
    );

  const pull = (current: SyncState) =>
    client.internal.authSyncPull({
      headers,
      payload: {
        known: PROVIDERS.flatMap((provider) => {
          const synced = current.files[provider];
          return synced === undefined ? [] : [{ provider, version: synced.version }];
        }),
      },
    });

  const syncProvider = Effect.fn("O3AuthSync.syncProvider")(function* (
    provider: InstanceAuthSyncProvider,
    pulled: InstanceAuthSyncPullResult,
    current: SyncState,
  ) {
    const file = fileFor(provider);
    const local = yield* readLocal(file);
    const unchanged = { synced: current.files[provider], rewrote: false };
    if (local !== null && !isCompleteCredential(local)) return unchanged;
    const plan = planProviderSync({
      local,
      synced: current.files[provider],
      remote: pulled.files.find((entry) => entry.provider === provider),
    });
    switch (plan.kind) {
      case "none":
        return unchanged;
      case "apply": {
        if (plan.backup && local !== null) {
          yield* fs.writeFileString(`${file}${BACKUP_SUFFIX}`, local, { mode: 0o600 });
        }
        const rewrote = plan.content !== local;
        if (rewrote) yield* writeLocal(file, plan.content);
        return { synced: { version: plan.version, hash: contentHash(plan.content) }, rewrote };
      }
      case "push": {
        const result = yield* client.internal.authSyncPush({
          headers,
          payload: { provider, baseVersion: plan.baseVersion, content: plan.content },
        });
        if (result.current === null) return unchanged;
        const rewrote = !result.accepted && result.current.content !== local;
        if (rewrote) yield* writeLocal(file, result.current.content);
        return {
          synced: { version: result.current.version, hash: contentHash(result.current.content) },
          rewrote,
        };
      }
    }
  });

  const tick = Effect.gen(function* () {
    let current = yield* Ref.get(state);
    let pulled = yield* pull(current);
    if (pulled.groupId !== current.groupId) {
      // Joined, switched or left a group: earlier versions belong to another group.
      current = { groupId: pulled.groupId, files: {} };
      if (pulled.groupId !== null) pulled = yield* pull(current);
    }
    const rewritten: Array<InstanceAuthSyncProvider> = [];
    if (pulled.groupId === null) {
      if (current !== (yield* Ref.get(state))) yield* save(current);
      return rewritten;
    }
    const files: Record<string, SyncedFile> = {};
    for (const provider of PROVIDERS) {
      const result = yield* syncProvider(provider, pulled, current).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Couldn't sync an agent sign-in.", { provider, cause }).pipe(
            Effect.as({ synced: current.files[provider], rewrote: false }),
          ),
        ),
      );
      if (result.synced !== undefined) files[provider] = result.synced;
      if (result.rewrote) rewritten.push(provider);
    }
    const next = { groupId: pulled.groupId, files };
    if (!sameState(next, yield* Ref.get(state))) yield* save(next);
    return rewritten;
  }).pipe(
    Effect.catch((cause) =>
      Effect.logDebug("Sign-in sync with the instance failed.", { cause }).pipe(
        Effect.as<ReadonlyArray<InstanceAuthSyncProvider>>([]),
      ),
    ),
    Effect.withSpan("O3AuthSync.tick"),
  );

  return Option.some(tick);
});

/**
 * Keeps this workspace's agent CLI sign-ins in step with its instance sign-in sync group, and has
 * each provider whose file changed re-check its sign-in so the app stops showing a stale status.
 */
const run = Effect.gen(function* () {
  const tick = yield* make;
  if (Option.isNone(tick)) return;
  const registry = yield* ProviderRegistry;
  yield* tick.value.pipe(
    Effect.flatMap((rewritten) =>
      Effect.forEach(rewritten, (provider) => registry.refresh(DRIVER_KINDS[provider]), {
        discard: true,
      }),
    ),
    Effect.repeat(Schedule.spaced(SYNC_INTERVAL)),
    Effect.forkScoped,
  );
});

export const layer = Layer.effectDiscard(run).pipe(Layer.provide(FetchHttpClient.layer));
