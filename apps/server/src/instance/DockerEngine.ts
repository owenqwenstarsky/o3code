// @effect-diagnostics nodeBuiltinImport:off -- Docker's Engine API is HTTP over a unix socket, which Effect's HTTP client cannot dial.
import * as NodeHttp from "node:http";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// Docker Engine 25+; Engine 29 refuses anything older.
const API_VERSION = "v1.44";

export class DockerEngineError extends Schema.TaggedError<DockerEngineError>()(
  "DockerEngineError",
  {
    operation: Schema.String,
    status: Schema.optionalKey(Schema.Number),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Docker ${this.operation} failed${this.status === undefined ? "" : ` (${this.status})`}: ${this.detail}`;
  }
}

export interface DockerContainerState {
  readonly id: string;
  readonly name: string;
  readonly image: string;
  readonly status: string;
  readonly running: boolean;
  readonly exitCode: number;
  readonly error: string;
  readonly startedAt: string;
  /** Host ports bound to container TCP ports, from the container's own config. */
  readonly publishedPorts: ReadonlyArray<{
    readonly containerPort: number;
    readonly hostPort: number;
  }>;
}

export interface DockerContainerSpec {
  readonly name: string;
  readonly image: string;
  readonly env: Readonly<Record<string, string>>;
  readonly labels: Readonly<Record<string, string>>;
  readonly hostname: string;
  readonly network: string;
  readonly mounts: ReadonlyArray<{ readonly volume: string; readonly target: string }>;
  readonly cpus: number;
  readonly memoryBytes: number;
  readonly pids: number;
  readonly capAdd: ReadonlyArray<string>;
  readonly devices: ReadonlyArray<string>;
  readonly publish?: ReadonlyArray<{
    readonly containerPort: number;
    readonly hostIp: string;
    readonly hostPort: number;
  }>;
}

export interface DockerInfo {
  readonly serverVersion: string;
  readonly cpus: number;
  readonly memoryBytes: number;
}

interface RawResponse {
  readonly status: number;
  readonly body: Buffer;
}

export class DockerEngine extends Context.Service<
  DockerEngine,
  {
    readonly info: Effect.Effect<DockerInfo, DockerEngineError>;
    readonly ensureImage: (image: string) => Effect.Effect<void, DockerEngineError>;
    readonly pullImage: (image: string) => Effect.Effect<void, DockerEngineError>;
    readonly ensureNetwork: (name: string) => Effect.Effect<void, DockerEngineError>;
    readonly ensureVolume: (
      name: string,
      labels: Readonly<Record<string, string>>,
    ) => Effect.Effect<void, DockerEngineError>;
    readonly removeVolume: (name: string) => Effect.Effect<void, DockerEngineError>;
    readonly volumeSizes: Effect.Effect<ReadonlyMap<string, number>, DockerEngineError>;
    readonly createContainer: (
      spec: DockerContainerSpec,
    ) => Effect.Effect<string, DockerEngineError>;
    readonly startContainer: (id: string) => Effect.Effect<void, DockerEngineError>;
    readonly stopContainer: (id: string) => Effect.Effect<void, DockerEngineError>;
    readonly restartContainer: (id: string) => Effect.Effect<void, DockerEngineError>;
    readonly removeContainer: (id: string) => Effect.Effect<void, DockerEngineError>;
    readonly inspectContainer: (
      nameOrId: string,
    ) => Effect.Effect<Option.Option<DockerContainerState>, DockerEngineError>;
    readonly logs: (id: string, tail: number) => Effect.Effect<string, DockerEngineError>;
    readonly exec: (
      id: string,
      cmd: ReadonlyArray<string>,
    ) => Effect.Effect<{ readonly exitCode: number; readonly output: string }, DockerEngineError>;
  }
>()("t3/instance/DockerEngine") {}

/** Non-TTY attach and log streams frame each chunk with an 8-byte header. */
export function demuxDockerStream(buffer: Buffer): string {
  const chunks: Array<Buffer> = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const streamType = buffer[offset];
    const size = buffer.readUInt32BE(offset + 4);
    if (streamType === undefined || streamType > 2) {
      // Not multiplexed (TTY container); return as-is.
      return buffer.toString("utf8");
    }
    chunks.push(buffer.subarray(offset + 8, offset + 8 + size));
    offset += 8 + size;
  }
  return Buffer.concat(chunks).toString("utf8");
}

const InfoResponse = Schema.Struct({
  ServerVersion: Schema.String,
  NCPU: Schema.Number,
  MemTotal: Schema.Number,
});

const InspectResponse = Schema.Struct({
  Id: Schema.String,
  Name: Schema.String,
  Config: Schema.Struct({ Image: Schema.String }),
  State: Schema.Struct({
    Status: Schema.String,
    Running: Schema.Boolean,
    ExitCode: Schema.Number,
    Error: Schema.optionalKey(Schema.String),
    StartedAt: Schema.optionalKey(Schema.String),
  }),
  HostConfig: Schema.optionalKey(
    Schema.Struct({
      PortBindings: Schema.optionalKey(
        Schema.NullOr(
          Schema.Record(
            Schema.String,
            Schema.NullOr(
              Schema.Array(Schema.Struct({ HostPort: Schema.optionalKey(Schema.String) })),
            ),
          ),
        ),
      ),
    }),
  ),
});

const publishedPorts = (raw: typeof InspectResponse.Type) =>
  Object.entries(raw.HostConfig?.PortBindings ?? {}).flatMap(([key, bindings]) => {
    const containerPort = Number.parseInt(key, 10);
    return (bindings ?? []).flatMap((binding) => {
      const hostPort = Number.parseInt(binding.HostPort ?? "", 10);
      return Number.isInteger(containerPort) && hostPort > 0 ? [{ containerPort, hostPort }] : [];
    });
  });

const CreateResponse = Schema.Struct({ Id: Schema.String });
const decodeErrorBody = Schema.decodeOption(
  Schema.fromJsonString(Schema.Struct({ message: Schema.String })),
);
const decodePullLine = Schema.decodeOption(
  Schema.fromJsonString(Schema.Struct({ error: Schema.optionalKey(Schema.String) })),
);
const encodeBody = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const ExecCreateResponse = Schema.Struct({ Id: Schema.String });
const ExecInspectResponse = Schema.Struct({ ExitCode: Schema.NullOr(Schema.Number) });
const SystemDfResponse = Schema.Struct({
  Volumes: Schema.NullOr(
    Schema.Array(
      Schema.Struct({
        Name: Schema.String,
        UsageData: Schema.optionalKey(Schema.NullOr(Schema.Struct({ Size: Schema.Number }))),
      }),
    ),
  ),
});

const makeDockerEngine = (socketPath: string) => {
  const request = (
    operation: string,
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = 60_000,
  ) =>
    Effect.callback<RawResponse, DockerEngineError>((resume, signal) => {
      const payload = body === undefined ? undefined : Buffer.from(encodeBody(body));
      const req = NodeHttp.request(
        {
          socketPath,
          path: `/${API_VERSION}${path}`,
          method,
          headers: {
            host: "docker",
            ...(payload
              ? { "content-type": "application/json", "content-length": payload.length }
              : {}),
          },
          signal,
          timeout: timeoutMs,
        },
        (res) => {
          const chunks: Array<Buffer> = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () =>
            resume(Effect.succeed({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) })),
          );
          res.on("error", (error) =>
            resume(Effect.fail(new DockerEngineError({ operation, detail: error.message }))),
          );
        },
      );
      req.on("timeout", () => req.destroy(new Error(`timed out after ${timeoutMs} ms`)));
      req.on("error", (error) => {
        if (signal.aborted) return;
        resume(Effect.fail(new DockerEngineError({ operation, detail: error.message })));
      });
      req.end(payload);
    });

  const errorDetail = (response: RawResponse) => {
    const text = response.body.toString("utf8");
    return Option.match(decodeErrorBody(text), {
      onNone: () => text,
      onSome: (parsed) => parsed.message,
    });
  };

  const expect =
    (
      operation: string,
      ok: ReadonlyArray<number>,
    ): ((response: RawResponse) => Effect.Effect<RawResponse, DockerEngineError>) =>
    (response) =>
      ok.includes(response.status)
        ? Effect.succeed(response)
        : Effect.fail(
            new DockerEngineError({
              operation,
              status: response.status,
              detail: errorDetail(response),
            }),
          );

  const decodeJson =
    <A>(operation: string, decode: (text: string) => Effect.Effect<A, Schema.SchemaError>) =>
    (response: RawResponse) =>
      decode(response.body.toString("utf8")).pipe(
        Effect.mapError(
          (cause) => new DockerEngineError({ operation, detail: `unexpected response: ${cause}` }),
        ),
      );

  const call = <A>(
    operation: string,
    method: string,
    path: string,
    ok: ReadonlyArray<number>,
    then: (response: RawResponse) => Effect.Effect<A, DockerEngineError>,
    body?: unknown,
    timeoutMs?: number,
  ) =>
    request(operation, method, path, body, timeoutMs).pipe(
      Effect.flatMap(expect(operation, ok)),
      Effect.flatMap(then),
      Effect.withSpan(`DockerEngine.${operation}`),
    );

  const done = () => Effect.void;

  const imageRef = (image: string) => {
    const at = image.lastIndexOf(":");
    const slash = image.lastIndexOf("/");
    return at > slash
      ? { fromImage: image.slice(0, at), tag: image.slice(at + 1) }
      : { fromImage: image, tag: "latest" };
  };

  const pullImage = (image: string) => {
    const { fromImage, tag } = imageRef(image);
    return call(
      "pullImage",
      "POST",
      `/images/create?fromImage=${encodeURIComponent(fromImage)}&tag=${encodeURIComponent(tag)}`,
      [200],
      (response) => {
        // The stream reports failures inline with a 200 status.
        const failure = response.body
          .toString("utf8")
          .split("\n")
          .flatMap((line) => Option.toArray(decodePullLine(line)))
          .find((line) => line.error !== undefined);
        return failure?.error
          ? Effect.fail(new DockerEngineError({ operation: "pullImage", detail: failure.error }))
          : Effect.void;
      },
      undefined,
      30 * 60_000,
    );
  };

  const multiplexedOutput = (response: RawResponse) =>
    Effect.succeed(demuxDockerStream(response.body));

  return DockerEngine.of({
    info: call("info", "GET", "/info", [200], (response) =>
      decodeJson(
        "info",
        Schema.decodeEffect(Schema.fromJsonString(InfoResponse)),
      )(response).pipe(
        Effect.map((info) => ({
          serverVersion: info.ServerVersion,
          cpus: info.NCPU,
          memoryBytes: info.MemTotal,
        })),
      ),
    ),
    pullImage,
    ensureImage: Effect.fn("DockerEngine.ensureImage")((image) =>
      request("inspectImage", "GET", `/images/${encodeURIComponent(image)}/json`).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.void
            : response.status === 404
              ? pullImage(image)
              : expect("inspectImage", [200])(response).pipe(Effect.asVoid),
        ),
      ),
    ),
    ensureNetwork: Effect.fn("DockerEngine.ensureNetwork")((name) =>
      request("inspectNetwork", "GET", `/networks/${encodeURIComponent(name)}`).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.void
            : call("createNetwork", "POST", "/networks/create", [201, 409], done, {
                Name: name,
                Driver: "bridge",
                // Workspaces reach the internet and the tailnet, never each other.
                Options: { "com.docker.network.bridge.enable_icc": "false" },
                Labels: { "dev.o3code.managed": "true" },
              }),
        ),
      ),
    ),
    ensureVolume: Effect.fn("DockerEngine.ensureVolume")((name, labels) =>
      call("createVolume", "POST", "/volumes/create", [201], done, { Name: name, Labels: labels }),
    ),
    removeVolume: Effect.fn("DockerEngine.removeVolume")((name) =>
      call("removeVolume", "DELETE", `/volumes/${encodeURIComponent(name)}`, [204, 404], done),
    ),
    volumeSizes: call("systemDf", "GET", "/system/df?type=volume", [200], (response) =>
      decodeJson(
        "systemDf",
        Schema.decodeEffect(Schema.fromJsonString(SystemDfResponse)),
      )(response).pipe(
        Effect.map(
          (df) =>
            new Map(
              (df.Volumes ?? []).flatMap((volume) =>
                volume.UsageData && volume.UsageData.Size >= 0
                  ? [[volume.Name, volume.UsageData.Size] as const]
                  : [],
              ),
            ),
        ),
      ),
    ),
    createContainer: Effect.fn("DockerEngine.createContainer")((spec) =>
      call(
        "createContainer",
        "POST",
        `/containers/create?name=${encodeURIComponent(spec.name)}`,
        [201],
        (response) =>
          decodeJson(
            "createContainer",
            Schema.decodeEffect(Schema.fromJsonString(CreateResponse)),
          )(response).pipe(Effect.map((r) => r.Id)),
        {
          Image: spec.image,
          Hostname: spec.hostname,
          Env: Object.entries(spec.env).map(([key, value]) => `${key}=${value}`),
          Labels: spec.labels,
          ...(spec.publish
            ? {
                ExposedPorts: Object.fromEntries(
                  spec.publish.map((port) => [`${port.containerPort}/tcp`, {}]),
                ),
              }
            : {}),
          HostConfig: {
            NetworkMode: spec.network,
            ...(spec.publish
              ? {
                  PortBindings: Object.fromEntries(
                    spec.publish.map((port) => [
                      `${port.containerPort}/tcp`,
                      [{ HostIp: port.hostIp, HostPort: String(port.hostPort) }],
                    ]),
                  ),
                }
              : {}),
            Mounts: spec.mounts.map((mount) => ({
              Type: "volume",
              Source: mount.volume,
              Target: mount.target,
            })),
            NanoCpus: Math.round(spec.cpus * 1e9),
            Memory: spec.memoryBytes,
            PidsLimit: spec.pids,
            CapAdd: spec.capAdd,
            Devices: spec.devices.map((path) => ({
              PathOnHost: path,
              PathInContainer: path,
              CgroupPermissions: "rwm",
            })),
            SecurityOpt: ["no-new-privileges:true"],
            RestartPolicy: { Name: "unless-stopped" },
            Init: true,
          },
        },
      ),
    ),
    startContainer: Effect.fn("DockerEngine.startContainer")((id) =>
      call(
        "startContainer",
        "POST",
        `/containers/${encodeURIComponent(id)}/start`,
        [204, 304],
        done,
      ),
    ),
    stopContainer: Effect.fn("DockerEngine.stopContainer")((id) =>
      call(
        "stopContainer",
        "POST",
        `/containers/${encodeURIComponent(id)}/stop?t=20`,
        [204, 304, 404],
        done,
        undefined,
        60_000,
      ),
    ),
    restartContainer: Effect.fn("DockerEngine.restartContainer")((id) =>
      call(
        "restartContainer",
        "POST",
        `/containers/${encodeURIComponent(id)}/restart?t=20`,
        [204],
        done,
        undefined,
        60_000,
      ),
    ),
    removeContainer: Effect.fn("DockerEngine.removeContainer")((id) =>
      call(
        "removeContainer",
        "DELETE",
        `/containers/${encodeURIComponent(id)}?force=true`,
        [204, 404],
        done,
      ),
    ),
    inspectContainer: Effect.fn("DockerEngine.inspectContainer")((nameOrId) =>
      request("inspectContainer", "GET", `/containers/${encodeURIComponent(nameOrId)}/json`).pipe(
        Effect.flatMap((response) =>
          response.status === 404
            ? Effect.succeed(Option.none<DockerContainerState>())
            : expect(
                "inspectContainer",
                [200],
              )(response).pipe(
                Effect.flatMap(
                  decodeJson(
                    "inspectContainer",
                    Schema.decodeEffect(Schema.fromJsonString(InspectResponse)),
                  ),
                ),
                Effect.map((raw) =>
                  Option.some<DockerContainerState>({
                    id: raw.Id,
                    name: raw.Name.replace(/^\//, ""),
                    image: raw.Config.Image,
                    status: raw.State.Status,
                    running: raw.State.Running,
                    exitCode: raw.State.ExitCode,
                    error: raw.State.Error ?? "",
                    startedAt: raw.State.StartedAt ?? "",
                    publishedPorts: publishedPorts(raw),
                  }),
                ),
              ),
        ),
      ),
    ),
    logs: Effect.fn("DockerEngine.logs")((id, tail) =>
      call(
        "logs",
        "GET",
        `/containers/${encodeURIComponent(id)}/logs?stdout=1&stderr=1&timestamps=1&tail=${tail}`,
        [200],
        multiplexedOutput,
      ),
    ),
    exec: Effect.fn("DockerEngine.exec")((id, cmd) =>
      Effect.gen(function* () {
        const created = yield* call(
          "execCreate",
          "POST",
          `/containers/${encodeURIComponent(id)}/exec`,
          [201],
          decodeJson("execCreate", Schema.decodeEffect(Schema.fromJsonString(ExecCreateResponse))),
          { AttachStdout: true, AttachStderr: true, Cmd: cmd },
        );
        const output = yield* call(
          "execStart",
          "POST",
          `/exec/${created.Id}/start`,
          [200],
          multiplexedOutput,
          { Detach: false, Tty: false },
          30_000,
        );
        const inspected = yield* call(
          "execInspect",
          "GET",
          `/exec/${created.Id}/json`,
          [200],
          decodeJson(
            "execInspect",
            Schema.decodeEffect(Schema.fromJsonString(ExecInspectResponse)),
          ),
        );
        return { exitCode: inspected.ExitCode ?? -1, output };
      }),
    ),
  });
};

export const layer = (socketPath: string) =>
  Layer.succeed(DockerEngine, makeDockerEngine(socketPath));
