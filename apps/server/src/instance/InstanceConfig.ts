import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

export type TailscaleCredentials =
  | {
      readonly mode: "oauth";
      readonly clientId: string;
      readonly clientSecret: Redacted.Redacted<string>;
      readonly tailnet: string;
    }
  | { readonly mode: "authkey"; readonly authKey: Redacted.Redacted<string> }
  | { readonly mode: "none" };

export type WorkspaceRuntimeConfig =
  | {
      readonly kind: "docker";
      readonly socketPath: string;
      readonly network: string;
    }
  | {
      /** Every workspace is one already-running T3 server; for development only. */
      readonly kind: "static";
      readonly url: string;
      /** The dev server's `T3CODE_O3_WORKSPACE_SECRET`, with `T3CODE_O3_WORKSPACE_ID=static`. */
      readonly secret: Redacted.Redacted<string>;
    };

export class InstanceConfig extends Context.Service<
  InstanceConfig,
  {
    readonly initialName: string;
    readonly initialWorkspaceImage: string;
    readonly bootstrapAdmin: Option.Option<{
      readonly email: string;
      readonly password: Redacted.Redacted<string>;
    }>;
    /** How workspaces reach this instance; discovered from Tailscale when unset. */
    readonly instanceUrl: Option.Option<string>;
    readonly runtime: WorkspaceRuntimeConfig;
    readonly tailscale: TailscaleCredentials;
    readonly tailscaleTag: string;
  }
>()("t3/instance/InstanceConfig") {}

const optionalString = (name: string) =>
  Config.String(name).pipe(
    Config.option,
    Config.map(Option.filter((value) => value.trim().length > 0)),
  );

const fromEnv = Effect.gen(function* () {
  const initialName = yield* Config.String("O3_INSTANCE_NAME").pipe(Config.withDefault("O3 Code"));
  const initialWorkspaceImage = yield* Config.String("O3_WORKSPACE_IMAGE").pipe(
    Config.withDefault("o3code/workspace:latest"),
  );
  const adminEmail = yield* optionalString("O3_ADMIN_EMAIL");
  const adminPassword = yield* Config.Redacted("O3_ADMIN_PASSWORD").pipe(Config.option);
  const instanceUrl = yield* optionalString("O3_INSTANCE_URL");
  const runtimeKind = yield* Config.Literals(["docker", "static"], "O3_WORKSPACE_RUNTIME").pipe(
    Config.withDefault("docker" as const),
  );
  const runtime: WorkspaceRuntimeConfig =
    runtimeKind === "static"
      ? {
          kind: "static",
          url: yield* Config.String("O3_STATIC_WORKSPACE_URL"),
          secret: yield* Config.Redacted("O3_STATIC_WORKSPACE_SECRET"),
        }
      : {
          kind: "docker",
          socketPath: yield* Config.String("O3_DOCKER_SOCKET").pipe(
            Config.withDefault("/var/run/docker.sock"),
          ),
          network: yield* Config.String("O3_WORKSPACE_NETWORK").pipe(
            Config.withDefault("o3-workspaces"),
          ),
        };
  const clientId = yield* optionalString("O3_TS_OAUTH_CLIENT_ID");
  const clientSecret = yield* Config.Redacted("O3_TS_OAUTH_CLIENT_SECRET").pipe(Config.option);
  const authKey = yield* Config.Redacted("O3_TS_AUTHKEY").pipe(Config.option);
  const tailnet = yield* Config.String("O3_TS_TAILNET").pipe(Config.withDefault("-"));
  const tailscaleTag = yield* Config.String("O3_TS_TAG").pipe(
    Config.withDefault("tag:o3-workspace"),
  );

  const tailscale: TailscaleCredentials =
    Option.isSome(clientId) && Option.isSome(clientSecret)
      ? { mode: "oauth", clientId: clientId.value, clientSecret: clientSecret.value, tailnet }
      : Option.isSome(authKey)
        ? { mode: "authkey", authKey: authKey.value }
        : { mode: "none" };

  return InstanceConfig.of({
    initialName,
    initialWorkspaceImage,
    bootstrapAdmin:
      Option.isSome(adminEmail) && Option.isSome(adminPassword)
        ? Option.some({ email: adminEmail.value, password: adminPassword.value })
        : Option.none(),
    instanceUrl,
    runtime,
    tailscale,
    tailscaleTag,
  });
});

export const layerFromEnv = Layer.effect(InstanceConfig, fromEnv);
