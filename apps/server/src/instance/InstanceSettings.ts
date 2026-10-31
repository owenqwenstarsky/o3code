import { InstanceSettings as InstanceSettingsSchema } from "@t3tools/contracts/instance";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { InstanceConfig } from "./InstanceConfig.ts";
import { InstanceStore, type InstanceStoreError, type AuditInput } from "./InstanceStore.ts";
import { DEFAULT_TOOL_IDS } from "./WorkspaceTools.ts";

type Settings = typeof InstanceSettingsSchema.Type;

const SETTINGS_KEY = "instance";
const decodeSettings = Schema.decodeUnknownEffect(Schema.fromJsonString(InstanceSettingsSchema));
const encodeSettings = Schema.encodeEffect(Schema.fromJsonString(InstanceSettingsSchema));

export class InstanceSettings extends Context.Service<
  InstanceSettings,
  {
    readonly get: Effect.Effect<Settings, InstanceStoreError>;
    readonly update: (next: Settings) => Effect.Effect<Settings, InstanceStoreError>;
    readonly audit: (event: AuditInput) => Effect.Effect<void>;
  }
>()("t3/instance/InstanceSettings") {}

const make = Effect.gen(function* () {
  const store = yield* InstanceStore;
  const config = yield* InstanceConfig;
  const defaults: Settings = {
    name: config.initialName,
    sessionTtlDays: 30,
    defaultTools: DEFAULT_TOOL_IDS,
    defaultLimits: { cpus: 2, memoryMb: 4096, pids: 4096 },
    workspaceImage: config.initialWorkspaceImage,
  };

  const get = store.getSetting(SETTINGS_KEY).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(defaults),
        onSome: (raw) =>
          decodeSettings(raw).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Stored instance settings are invalid; using defaults.", {
                cause,
              }).pipe(Effect.as(defaults)),
            ),
          ),
      }),
    ),
  );

  return InstanceSettings.of({
    get,
    update: Effect.fn("InstanceSettings.update")((next) =>
      encodeSettings(next).pipe(
        Effect.orDie,
        Effect.flatMap((json) => store.putSetting(SETTINGS_KEY, json)),
        Effect.as(next),
      ),
    ),
    // Audit writes never fail the action they record.
    audit: Effect.fn("InstanceSettings.audit")((event) =>
      DateTime.now.pipe(
        Effect.flatMap((now) => store.appendAudit({ ...event, at: DateTime.formatIso(now) })),
        Effect.catch((cause) => Effect.logError("Failed to record audit event.", { cause, event })),
      ),
    ),
  });
});

export const layer = Layer.effect(InstanceSettings, make);
