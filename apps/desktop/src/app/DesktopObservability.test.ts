import desktopPackageJson from "../../package.json" with { type: "json" };
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopObservability from "./DesktopObservability.ts";

const environmentInput = (baseDir: string) =>
  ({
    dirname: "/repo/apps/desktop/dist-electron",
    homeDirectory: baseDir,
    platform: "darwin",
    processArch: "arm64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged: false,
    resourcesPath: "/repo/resources",
    runningUnderArm64Translation: false,
  }) satisfies DesktopEnvironment.MakeDesktopEnvironmentInput;

const layerEnvironmentFor = (
  baseDir: string,
  isDevelopment = true,
  env: Readonly<Record<string, string | undefined>> = {},
) =>
  DesktopEnvironment.layer(environmentInput(baseDir)).pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        DesktopConfig.layerTest({
          T3CODE_HOME: baseDir,
          VITE_DEV_SERVER_URL: isDevelopment ? "http://127.0.0.1:5733" : undefined,
          ...env,
        }),
      ),
    ),
  );

interface ExportedRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

const layerCollector = (requests: Array<ExportedRequest>) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        requests.push({
          url: request.url,
          headers: request.headers,
          body:
            request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "",
        });
        return HttpClientResponse.fromWeb(request, new Response(null, { status: 200 }));
      }),
    ),
  );

// A developer's own OTEL_* variables would otherwise pick the endpoints.
const layerEmptyEnv = ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }));

const encodeObservabilitySettingsFile = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({ observability: Schema.Record(Schema.String, Schema.String) }),
  ),
);

const writeObservabilitySettings = Effect.fn(function* (
  environmentLayer: ReturnType<typeof layerEnvironmentFor>,
  observability: Readonly<Record<string, string>>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const { path, serverSettingsPath } = yield* Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    return environment;
  }).pipe(Effect.provide(environmentLayer));
  yield* fileSystem.makeDirectory(path.dirname(serverSettingsPath), { recursive: true });
  yield* fileSystem.writeFileString(
    serverSettingsPath,
    encodeObservabilitySettingsFile({ observability }),
  );
});

describe("DesktopObservability", () => {
  it.effect("stops every export when the OpenTelemetry SDK is disabled", () => {
    const requests: Array<ExportedRequest> = [];
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-observability-test-",
      });
      const layerEnvironment = layerEnvironmentFor(baseDir);
      yield* writeObservabilitySettings(layerEnvironment, {
        otlpTracesUrl: "https://settings.example.com/v1/traces",
        otlpLogsUrl: "https://settings.example.com/v1/logs",
      });

      yield* Effect.scoped(
        Effect.logInfo("desktop log stays local when disabled").pipe(
          Effect.withSpan("desktop-disabled-test"),
          Effect.provide(DesktopObservability.layer.pipe(Layer.provideMerge(layerEnvironment))),
        ),
      );

      assert.lengthOf(requests, 0);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          layerCollector(requests),
          ConfigProvider.layer(ConfigProvider.fromEnv({ env: { OTEL_SDK_DISABLED: "true" } })),
        ),
      ),
    );
  });

  it.effect("reports the app's own version for an unpackaged desktop run", () => {
    const requests: Array<ExportedRequest> = [];
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-observability-test-",
      });
      const layerEnvironment = layerEnvironmentFor(baseDir);
      yield* writeObservabilitySettings(layerEnvironment, {
        otlpLogsUrl: "https://settings.example.com/v1/logs",
      });

      yield* Effect.scoped(
        Effect.logInfo("desktop resource under test").pipe(
          Effect.provide(DesktopObservability.layer.pipe(Layer.provideMerge(layerEnvironment))),
        ),
      );

      const body = requests.map((request) => request.body).join("\n");
      assert.include(
        body,
        `"key":"service.version","value":{"stringValue":"${desktopPackageJson.version}"}`,
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(NodeServices.layer, layerCollector(requests), layerEmptyEnv)),
    );
  });

  it.effect("describes the Node runtime and the desktop mode under semantic or t3code keys", () => {
    const requests: Array<ExportedRequest> = [];
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-observability-test-",
      });
      const layerEnvironment = layerEnvironmentFor(baseDir);
      yield* writeObservabilitySettings(layerEnvironment, {
        otlpLogsUrl: "https://settings.example.com/v1/logs",
      });

      yield* Effect.scoped(
        Effect.logInfo("desktop resource under test").pipe(
          Effect.provide(DesktopObservability.layer.pipe(Layer.provideMerge(layerEnvironment))),
        ),
      );

      const body = requests.map((request) => request.body).join("\n");
      assert.include(body, '"key":"process.runtime.name","value":{"stringValue":"nodejs"}');
      assert.include(
        body,
        `"key":"process.runtime.version","value":{"stringValue":"${process.versions.node}"}`,
      );
      assert.include(body, '"key":"t3code.desktop.mode","value":{"stringValue":"development"}');
      assert.notInclude(body, "service.mode");
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(NodeServices.layer, layerCollector(requests), layerEmptyEnv)),
    );
  });
});
