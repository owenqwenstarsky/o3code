import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";

import { InstanceConfig } from "./InstanceConfig.ts";

const TAILSCALE_API = "https://api.tailscale.com/api/v2";

export class TailscaleKeysError extends Schema.TaggedError<TailscaleKeysError>()(
  "TailscaleKeysError",
  { operation: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `Tailscale ${this.operation} failed: ${this.detail}`;
  }
}

export class TailscaleKeys extends Context.Service<
  TailscaleKeys,
  {
    readonly mode: "oauth" | "authkey" | "none";
    /** A preauthorized auth key that adds one tagged device. */
    readonly mintAuthKey: (
      description: string,
    ) => Effect.Effect<Redacted.Redacted<string>, TailscaleKeysError>;
    readonly deleteDeviceByHostname: (hostname: string) => Effect.Effect<void, TailscaleKeysError>;
  }
>()("t3/instance/TailscaleKeys") {}

const TokenResponse = Schema.Struct({ access_token: Schema.String });
const KeyResponse = Schema.Struct({ key: Schema.String });
const DevicesResponse = Schema.Struct({
  devices: Schema.Array(Schema.Struct({ id: Schema.String, hostname: Schema.String })),
});

const make = Effect.gen(function* () {
  const config = yield* InstanceConfig;
  const http = yield* HttpClient.HttpClient;
  const credentials = config.tailscale;
  const tag = config.tailscaleTag;

  const fail = (operation: string) => (cause: unknown) =>
    new TailscaleKeysError({
      operation,
      detail: cause instanceof Error ? cause.message : String(cause),
    });

  const execute = (operation: string, request: HttpClientRequest.HttpClientRequest) =>
    http.execute(request).pipe(
      Effect.mapError(fail(operation)),
      Effect.filterOrElse(
        (response) => response.status >= 200 && response.status < 300,
        (response) =>
          response.text.pipe(
            Effect.mapError(fail(operation)),
            Effect.flatMap((text) =>
              Effect.fail(
                new TailscaleKeysError({
                  operation,
                  detail: `HTTP ${response.status}: ${text.slice(0, 500)}`,
                }),
              ),
            ),
          ),
      ),
      Effect.withSpan(`TailscaleKeys.${operation}`),
    );

  const sendJson = <A, I>(
    operation: string,
    request: HttpClientRequest.HttpClientRequest,
    schema: Schema.Codec<A, I>,
  ) =>
    execute(operation, request).pipe(
      Effect.flatMap((response) => response.json.pipe(Effect.mapError(fail(operation)))),
      Effect.flatMap((json) =>
        Schema.decodeUnknownEffect(schema)(json).pipe(Effect.mapError(fail(operation))),
      ),
    );

  if (credentials.mode !== "oauth") {
    return TailscaleKeys.of({
      mode: credentials.mode,
      mintAuthKey: Effect.fn("TailscaleKeys.mintAuthKey")(function* () {
        if (credentials.mode === "authkey") return credentials.authKey;
        return yield* new TailscaleKeysError({
          operation: "mintAuthKey",
          detail:
            "No Tailscale credentials. Set O3_TS_OAUTH_CLIENT_ID and O3_TS_OAUTH_CLIENT_SECRET.",
        });
      }),
      // A shared auth key cannot manage devices; an admin removes them in the Tailscale console.
      deleteDeviceByHostname: Effect.fn("TailscaleKeys.deleteDeviceByHostname")((hostname) =>
        Effect.logWarning("Remove this workspace's device in the Tailscale admin console.", {
          hostname,
        }),
      ),
    });
  }

  const accessToken = sendJson(
    "oauthToken",
    HttpClientRequest.post(`${TAILSCALE_API}/oauth/token`).pipe(
      HttpClientRequest.bodyUrlParams({
        client_id: credentials.clientId,
        client_secret: Redacted.value(credentials.clientSecret),
        grant_type: "client_credentials",
      }),
    ),
    TokenResponse,
  ).pipe(Effect.map((response) => response.access_token));

  const tailnetPath = `${TAILSCALE_API}/tailnet/${encodeURIComponent(credentials.tailnet)}`;

  return TailscaleKeys.of({
    mode: "oauth",
    mintAuthKey: Effect.fn("TailscaleKeys.mintAuthKey")((description) =>
      Effect.gen(function* () {
        const token = yield* accessToken;
        const request = yield* HttpClientRequest.post(`${tailnetPath}/keys`).pipe(
          HttpClientRequest.bearerToken(token),
          HttpClientRequest.bodyJson({
            capabilities: {
              devices: {
                create: { reusable: false, ephemeral: false, preauthorized: true, tags: [tag] },
              },
            },
            expirySeconds: 3600,
            description: description.slice(0, 50),
          }),
          Effect.mapError(fail("mintAuthKey")),
        );
        const key = yield* sendJson("mintAuthKey", request, KeyResponse);
        return Redacted.make(key.key);
      }),
    ),
    deleteDeviceByHostname: Effect.fn("TailscaleKeys.deleteDeviceByHostname")((hostname) =>
      Effect.gen(function* () {
        const token = yield* accessToken;
        const devices = yield* sendJson(
          "listDevices",
          HttpClientRequest.get(`${tailnetPath}/devices`).pipe(
            HttpClientRequest.bearerToken(token),
          ),
          DevicesResponse,
        );
        const matching = Option.fromNullishOr(
          devices.devices.find((device) => device.hostname === hostname),
        );
        if (Option.isNone(matching)) return;
        yield* execute(
          "deleteDevice",
          HttpClientRequest.delete(
            `${TAILSCALE_API}/device/${encodeURIComponent(matching.value.id)}`,
          ).pipe(HttpClientRequest.bearerToken(token)),
        );
      }),
    ),
  });
});

export const layer = Layer.effect(TailscaleKeys, make);
