import {
  makeLocalFileTracer,
  makeTraceSink,
  nodeProcessRuntimeAttributes,
  processServiceInstanceId,
  type SignalExport,
} from "@t3tools/shared/observability";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as SharedObservability from "@t3tools/shared/observability";
import * as OtelEnvironment from "@t3tools/shared/otelEnvironment";
import { releaseChannelOf, releaseResourceAttributes } from "@t3tools/shared/releaseResource";
import {
  parsePersistedServerObservabilitySettings,
  type PersistedServerObservabilitySettings,
} from "@t3tools/shared/serverSettings";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as References from "effect/References";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Tracer from "effect/Tracer";
import { OtlpExporter, OtlpLogger, OtlpTracer } from "effect/observability";

import desktopPackageJson from "../../package.json" with { type: "json" };

import * as DesktopEnvironment from "./DesktopEnvironment.ts";

const DESKTOP_LOG_FILE_MAX_BYTES = 10 * 1024 * 1024;
const DESKTOP_LOG_FILE_MAX_FILES = 10;
const DESKTOP_TRACE_BATCH_WINDOW_MS = 1_000;

export interface RotatingLogFileWriter {
  readonly writeBytes: (chunk: Uint8Array) => Effect.Effect<void>;
  readonly writeText: (chunk: string) => Effect.Effect<void>;
}

const textEncoder = new TextEncoder();

export type DesktopLogAnnotations = Record<string, unknown>;

export interface DesktopComponentLogger {
  readonly annotate: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    annotations?: DesktopLogAnnotations,
  ) => Effect.Effect<A, E, R>;
  readonly logDebug: (message: string, annotations?: DesktopLogAnnotations) => Effect.Effect<void>;
  readonly logInfo: (message: string, annotations?: DesktopLogAnnotations) => Effect.Effect<void>;
  readonly logWarning: (
    message: string,
    annotations?: DesktopLogAnnotations,
  ) => Effect.Effect<void>;
  readonly logError: (message: string, annotations?: DesktopLogAnnotations) => Effect.Effect<void>;
}

export function makeComponentLogger(component: string): DesktopComponentLogger {
  const annotate: DesktopComponentLogger["annotate"] = (effect, annotations) =>
    effect.pipe(
      Effect.annotateLogs({
        component,
        ...annotations,
      }),
    );

  return {
    annotate,
    logDebug: (message, annotations) => annotate(Effect.logDebug(message), annotations),
    logInfo: (message, annotations) => annotate(Effect.logInfo(message), annotations),
    logWarning: (message, annotations) => annotate(Effect.logWarning(message), annotations),
    logError: (message, annotations) => annotate(Effect.logError(message), annotations),
  };
}

class DesktopLogFileWriterConfigurationError extends Schema.TaggedError<DesktopLogFileWriterConfigurationError>()(
  "DesktopLogFileWriterConfigurationError",
  {
    option: Schema.Literals(["maxBytes", "maxFiles"]),
    value: Schema.Number,
  },
) {
  override get message() {
    return `${this.option} must be >= 1 (received ${this.value})`;
  }
}

type DesktopLogFileWriterError =
  | DesktopLogFileWriterConfigurationError
  | PlatformError.PlatformError;

const refreshFileSize = (
  fileSystem: FileSystem.FileSystem,
  filePath: string,
): Effect.Effect<number, never> =>
  fileSystem.stat(filePath).pipe(
    Effect.map((stat) => Number(stat.size)),
    Effect.orElseSucceed(() => 0),
  );

export const makeRotatingLogFileWriter = Effect.fn("makeRotatingLogFileWriter")(function* (input: {
  readonly filePath: string;
  readonly maxBytes?: number;
  readonly maxFiles?: number;
}): Effect.fn.Return<
  RotatingLogFileWriter,
  DesktopLogFileWriterError,
  FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const maxBytes = input.maxBytes ?? DESKTOP_LOG_FILE_MAX_BYTES;
  const maxFiles = input.maxFiles ?? DESKTOP_LOG_FILE_MAX_FILES;
  const directory = path.dirname(input.filePath);
  const baseName = path.basename(input.filePath);

  if (maxBytes < 1) {
    return yield* new DesktopLogFileWriterConfigurationError({
      option: "maxBytes",
      value: maxBytes,
    });
  }
  if (maxFiles < 1) {
    return yield* new DesktopLogFileWriterConfigurationError({
      option: "maxFiles",
      value: maxFiles,
    });
  }

  yield* fileSystem.makeDirectory(directory, { recursive: true });

  const withSuffix = (index: number) => `${input.filePath}.${index}`;
  const currentSize = yield* Ref.make(yield* refreshFileSize(fileSystem, input.filePath));
  const mutex = yield* Semaphore.make(1);

  const pruneOverflowBackups = Effect.gen(function* () {
    const entries = yield* fileSystem.readDirectory(directory).pipe(Effect.orElseSucceed(() => []));
    for (const entry of entries) {
      if (!entry.startsWith(`${baseName}.`)) continue;
      const suffix = Number(entry.slice(baseName.length + 1));
      if (!Number.isInteger(suffix) || suffix <= maxFiles) continue;
      yield* fileSystem.remove(path.join(directory, entry), { force: true }).pipe(Effect.ignore);
    }
  });

  const rotate = Effect.gen(function* () {
    yield* fileSystem.remove(withSuffix(maxFiles), { force: true }).pipe(Effect.ignore);
    for (let index = maxFiles - 1; index >= 1; index -= 1) {
      const source = withSuffix(index);
      const sourceExists = yield* fileSystem.exists(source).pipe(Effect.orElseSucceed(() => false));
      if (sourceExists) {
        yield* fileSystem.rename(source, withSuffix(index + 1));
      }
    }
    const currentExists = yield* fileSystem
      .exists(input.filePath)
      .pipe(Effect.orElseSucceed(() => false));
    if (currentExists) {
      yield* fileSystem.rename(input.filePath, withSuffix(1));
    }
    yield* Ref.set(currentSize, 0);
  }).pipe(
    Effect.catch(() =>
      refreshFileSize(fileSystem, input.filePath).pipe(
        Effect.flatMap((size) => Ref.set(currentSize, size)),
      ),
    ),
  );

  const writeBytes = (chunk: Uint8Array): Effect.Effect<void> => {
    if (chunk.byteLength === 0) return Effect.void;

    return mutex.withPermits(1)(
      Effect.gen(function* () {
        const beforeSize = yield* Ref.get(currentSize);
        if (beforeSize > 0 && beforeSize + chunk.byteLength > maxBytes) {
          yield* rotate;
        }

        yield* fileSystem.writeFile(input.filePath, chunk, { flag: "a" });
        const afterSize = (yield* Ref.get(currentSize)) + chunk.byteLength;
        yield* Ref.set(currentSize, afterSize);

        if (afterSize > maxBytes) {
          yield* rotate;
        }
      }).pipe(
        Effect.catch(() =>
          refreshFileSize(fileSystem, input.filePath).pipe(
            Effect.flatMap((size) => Ref.set(currentSize, size)),
          ),
        ),
      ),
    );
  };

  yield* pruneOverflowBackups;

  return {
    writeBytes,
    writeText: (chunk) => writeBytes(textEncoder.encode(chunk)),
  } satisfies RotatingLogFileWriter;
});

const noPersistedObservabilitySettings: PersistedServerObservabilitySettings = {
  otlpTracesUrl: undefined,
  otlpMetricsUrl: undefined,
  otlpLogsUrl: undefined,
};

const readPersistedObservabilitySettings: Effect.Effect<
  PersistedServerObservabilitySettings,
  never,
  FileSystem.FileSystem | DesktopEnvironment.DesktopEnvironment
> = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const raw = yield* fileSystem.readFileString(environment.serverSettingsPath).pipe(Effect.option);
  return Option.isNone(raw)
    ? noPersistedObservabilitySettings
    : parsePersistedServerObservabilitySettings(raw.value);
});

const resolveOtlpEndpoints = Effect.gen(function* () {
  const otel = yield* OtelEnvironment.load;
  if (otel.disabled) {
    return {
      traces: undefined,
      metrics: undefined,
      logs: undefined,
      warnings: otel.warnings,
      resourceAttributes: otel.resourceAttributes,
    };
  }

  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const persisted = yield* readPersistedObservabilitySettings;
  const signalExport: SignalExport = {
    protocol: environment.otlpProtocol,
    headers: Option.getOrUndefined(environment.otlpHeaders),
    exportIntervalMs: environment.otlpExportIntervalMs,
  };
  return {
    traces: OtelEnvironment.resolveSignalEndpoint(
      otel,
      "traces",
      { url: Option.getOrUndefined(environment.otlpTracesUrl), export: signalExport },
      { bootstrapUrl: undefined, settingsUrl: persisted.otlpTracesUrl },
    ),
    metrics: OtelEnvironment.resolveSignalEndpoint(
      otel,
      "metrics",
      { url: Option.getOrUndefined(environment.otlpMetricsUrl), export: signalExport },
      { bootstrapUrl: undefined, settingsUrl: persisted.otlpMetricsUrl },
    ),
    logs: OtelEnvironment.resolveSignalEndpoint(
      otel,
      "logs",
      { url: Option.getOrUndefined(environment.otlpLogsUrl), export: signalExport },
      { bootstrapUrl: undefined, settingsUrl: persisted.otlpLogsUrl },
    ),
    warnings: otel.warnings,
    resourceAttributes: otel.resourceAttributes,
  };
});

const layerTelemetry = Layer.unwrap(
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const endpoints = yield* resolveOtlpEndpoints;
    // Unpackaged runs launch a script, so Electron reports its own version.
    const serviceVersion = environment.isPackaged
      ? environment.appVersion
      : desktopPackageJson.version;
    const resource = {
      serviceName: "t3code-desktop",
      serviceVersion,
      attributes: {
        "service.namespace": "t3code",
        "service.runtime": "desktop",
        "t3code.desktop.mode": environment.isDevelopment ? "development" : "packaged",
        "service.instance.id": processServiceInstanceId(endpoints.resourceAttributes),
        ...releaseResourceAttributes(
          environment.isDevelopment ? "dev" : releaseChannelOf(serviceVersion),
          endpoints.resourceAttributes,
        ),
        "host.name": endpoints.resourceAttributes["host.name"] || (yield* HostProcess.Hostname),
        ...nodeProcessRuntimeAttributes(),
      },
    };

    // Logger.layer replaces the logger set. tracerLogger would duplicate OTLP in-span messages.
    const layerLogger = Logger.layer(
      endpoints.logs === undefined
        ? [Logger.consolePretty(), Logger.tracerLogger]
        : [
            Logger.consolePretty(),
            OtlpLogger.make({
              url: endpoints.logs.url,
              exportInterval: `${endpoints.logs.export.exportIntervalMs} millis`,
              headers: endpoints.logs.export.headers,
              resource,
            }),
          ],
      { mergeWithExisting: false },
    ).pipe(
      Layer.provide(OtlpExporter.layerFlusher),
      Layer.provide(
        SharedObservability.layerOtlpSerialization(
          endpoints.logs?.export.protocol ?? environment.otlpProtocol,
        ),
      ),
    );

    const layerTracer = Layer.unwrap(
      Effect.gen(function* () {
        const tracePath = environment.path.join(environment.logDir, "desktop.trace.ndjson");
        const sink = yield* makeTraceSink({
          filePath: tracePath,
          maxBytes: DESKTOP_LOG_FILE_MAX_BYTES,
          maxFiles: DESKTOP_LOG_FILE_MAX_FILES,
          batchWindowMs: DESKTOP_TRACE_BATCH_WINDOW_MS,
        });
        const delegate =
          endpoints.traces === undefined
            ? undefined
            : yield* OtlpTracer.make({
                url: endpoints.traces.url,
                exportInterval: `${endpoints.traces.export.exportIntervalMs} millis`,
                headers: endpoints.traces.export.headers,
                resource,
              }).pipe(
                Effect.provide(
                  SharedObservability.layerOtlpSerialization(endpoints.traces.export.protocol),
                ),
              );
        const tracer = yield* makeLocalFileTracer({
          filePath: tracePath,
          maxBytes: DESKTOP_LOG_FILE_MAX_BYTES,
          maxFiles: DESKTOP_LOG_FILE_MAX_FILES,
          batchWindowMs: DESKTOP_TRACE_BATCH_WINDOW_MS,
          sink,
          ...(delegate ? { delegate } : {}),
        });

        return Layer.succeed(Tracer.Tracer, tracer);
      }),
    ).pipe(Layer.provide(OtlpExporter.layerFlusher));

    const layerOtelWarnings = Layer.effectDiscard(
      Effect.forEach(endpoints.warnings, (warning) => Effect.logWarning(warning)),
    );

    return layerOtelWarnings.pipe(
      Layer.provideMerge(Layer.mergeAll(layerLogger, layerTracer)),
      Layer.provide(OtelEnvironment.layerResourceAttributes(endpoints.resourceAttributes)),
    );
  }),
);

export const layer = Layer.mergeAll(
  layerTelemetry,
  Layer.succeed(References.MinimumLogLevel, "Info"),
  Layer.succeed(Tracer.MinimumTraceLevel, "Info"),
  Layer.succeed(References.TracerTimingEnabled, true),
);
