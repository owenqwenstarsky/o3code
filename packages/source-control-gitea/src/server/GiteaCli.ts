import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";
import * as ForgejoCli from "@t3tools/source-control-forgejo/server/ForgejoCli";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";

const encodeApiBody = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const LOGIN_HINT = "Run `gt auth login --host <server-url>` on the O3 Code server.";

// Machine-readable failures, no daily update check, and no repository from the environment:
// every request names its server, and its repository through the API path.
const GT_ENV = {
  GITEA_CLI_ERROR_FORMAT: "json",
  GITEA_CLI_NO_UPDATE_NOTIFIER: "1",
  GITEA_CLI_REPO: "",
  NO_COLOR: "1",
};

/** A row of `gt auth status --json`: one account, or the environment's `GITEA_TOKEN`. */
const GiteaAuthStatusRow = Schema.Struct({
  host: Schema.String,
  user: Schema.String,
  active: Schema.Boolean,
  credential_available: Schema.Boolean,
  verified: Schema.optional(Schema.NullOr(Schema.Boolean)),
  error: Schema.optional(Schema.NullOr(Schema.String)),
});
export type GiteaAuthStatusRow = typeof GiteaAuthStatusRow.Type;

export function parseGiteaAuthStatus(raw: string): ReadonlyArray<GiteaAuthStatusRow> {
  const decoded = decodeJsonResult(Schema.Array(GiteaAuthStatusRow))(raw);
  return Result.isSuccess(decoded) ? decoded.success : [];
}

/**
 * The accounts gt can use, in the login shape the Forgejo matcher reads. `host` is the
 * normalized instance URL, mount included; the active account of an instance is its default.
 */
export function parseGiteaLogins(
  raw: string,
): ReadonlyArray<typeof ForgejoCli.ForgejoLoginSchema.Type> {
  return parseGiteaAuthStatus(raw).flatMap((row) =>
    row.host && row.credential_available
      ? [
          {
            name: `${row.user}@${row.host}`,
            url: row.host.replace(/\/+$/, ""),
            user: row.user,
            default: String(row.active),
            valid: String(row.verified !== false),
          },
        ]
      : [],
  );
}

/** `--include` writes the status line to stderr; failures add one line of JSON after it. */
const GiteaCliErrorReport = Schema.Struct({
  error: Schema.Struct({
    kind: Schema.optional(Schema.String),
    message: Schema.optional(Schema.String),
    status: Schema.optional(Schema.Int),
  }),
});
const parseErrorReport = decodeJsonResult(GiteaCliErrorReport);

function errorReport(stderr: string) {
  for (const line of stderr.split("\n").reverse()) {
    if (!line.trim().startsWith("{")) continue;
    const report = parseErrorReport(line.trim());
    if (Result.isSuccess(report)) return report.success.error;
  }
  return undefined;
}

function responseStatus(stderr: string) {
  return Number(/^HTTP\/\S+ (\d{3})/m.exec(stderr)?.[1]) || errorReport(stderr)?.status;
}

const reasonForStatus = (status: number | undefined) =>
  status === 401
    ? ("authentication" as const)
    : status === 403
      ? ("forbidden" as const)
      : status === 404
        ? ("not-found" as const)
        : status === 429
          ? ("rate-limit" as const)
          : undefined;

export const make = Effect.gen(function* () {
  const { process } = yield* SourceControlHost.SourceControlHost;

  const run = (input: {
    readonly cwd: string;
    readonly args: ReadonlyArray<string>;
    readonly stdin?: string;
    readonly timeoutMs?: number;
    readonly maxOutputBytes?: number;
    readonly allowNonZeroExit?: boolean;
  }) =>
    process
      .run({
        ...input,
        operation: "GiteaCli.execute",
        command: "gt",
        env: GT_ENV,
        timeoutMs: input.timeoutMs ?? 30_000,
      })
      .pipe(
        Effect.mapError((cause) => {
          const missing = cause._tag === "VcsProcessSpawnError";
          const authentication =
            cause._tag === "VcsProcessExitError" && cause.failureKind === "authentication";
          return new ForgejoCli.ForgejoCliError({
            command: "gt",
            cwd: input.cwd,
            cause,
            ...(missing
              ? { reason: "missing-cli" as const }
              : authentication
                ? { reason: "authentication" as const }
                : {}),
            detail: missing
              ? "Install Gitea CLI (`gt` 1.0 or later) from https://gitea.com/gitea/cli and retry."
              : authentication
                ? `Authenticate this server with gt. ${LOGIN_HINT}`
                : "Gitea CLI command failed.",
          });
        }),
      );

  const execute: ForgejoCli.ForgejoCli["Service"]["execute"] = (input) => run(input);

  const listLogins: NonNullable<ForgejoCli.ForgejoCli["Service"]["listLogins"]> = Effect.fn(
    "GiteaCli.listLogins",
  )(function* (input) {
    // With --json, gt exits 0 even without accounts; the rows say what is usable.
    return parseGiteaLogins(
      (yield* run({ cwd: input.cwd, args: ["auth", "status", "--json"] })).stdout,
    );
  });

  /** One `gt api` request; a response outside 2xx fails. */
  const request = Effect.fn("GiteaCli.request")(function* (input: {
    readonly cwd: string;
    readonly baseUrl: string;
    readonly user: string;
    readonly path: string;
    readonly method?: ForgejoCli.ForgejoApiInput["method"];
    readonly body?: string;
  }) {
    const result = yield* run({
      cwd: input.cwd,
      args: [
        "api",
        "--include",
        "--host",
        input.baseUrl,
        ...(input.user ? ["--user", input.user] : []),
        "--method",
        input.method ?? "GET",
        ...(input.body === undefined ? [] : ["--input", "-"]),
        input.path,
      ],
      ...(input.body === undefined ? {} : { stdin: input.body }),
      allowNonZeroExit: true,
    });
    const status = responseStatus(result.stderr);
    if (result.exitCode === 0 && status !== undefined && status < 400) return result;
    const report = errorReport(result.stderr);
    const reason =
      reasonForStatus(status) ??
      (report?.kind === "authentication" ? ("authentication" as const) : undefined);
    return yield* new ForgejoCli.ForgejoCliError({
      command: "gt",
      cwd: input.cwd,
      ...(status ? { httpStatus: status } : {}),
      ...(reason ? { reason } : {}),
      detail:
        status === 404
          ? "Gitea repository or pull request was not found."
          : status === 429
            ? "Gitea API rate limit exceeded."
            : reason === "authentication" || reason === "forbidden"
              ? `Gitea denied access${report?.message ? `: ${report.message}` : "."} ${LOGIN_HINT}`
              : report?.message
                ? `Gitea API request failed: ${report.message}`
                : `Gitea API request failed${status ? ` (HTTP ${status})` : " without an HTTP status"}.`,
    });
  });

  const getAccount: NonNullable<ForgejoCli.ForgejoCli["Service"]["getAccount"]> = Effect.fn(
    "GiteaCli.getAccount",
  )(function* (input) {
    const result = yield* request({
      cwd: input.cwd,
      baseUrl: input.baseUrl,
      user: "",
      path: "user",
    });
    const user = decodeJsonResult(Schema.Struct({ login: Schema.String }))(result.stdout);
    if (Result.isFailure(user) || !user.success.login.trim())
      return yield* new ForgejoCli.ForgejoCliError({
        command: "gt",
        cwd: input.cwd,
        reason: "invalid-response",
        detail: "Gitea returned an invalid account response.",
      });
    return user.success.login;
  });

  const resolveTarget = Effect.fn("GiteaCli.resolveTarget")(function* (
    input: ForgejoCli.ForgejoRepositoryInput,
    hostOnly = false,
  ) {
    const { referenceRemote, remote } = yield* ForgejoCli.findForgejoRemote(process, input, "gt");
    const logins = yield* listLogins({ cwd: input.cwd, command: "gt" });
    const requestedHost = input.host ?? input.context?.requestedHost;
    const matchHostOnly = hostOnly || (!!input.host && !remote?.path);
    // Without a remote, only a single signed-in server is unambiguous.
    const login = remote
      ? ForgejoCli.matchForgejoLogin(
          logins,
          remote,
          remote.ssh ? requestedHost : undefined,
          matchHostOnly,
        )
      : new Set(logins.map((item) => item.url)).size === 1
        ? (logins.find((item) => item.default === "true") ?? logins[0])
        : undefined;
    if (!login)
      return yield* new ForgejoCli.ForgejoCliError({
        command: "gt",
        cwd: input.cwd,
        reason: "authentication",
        detail: `No matching gt account for this Gitea server. ${LOGIN_HINT} With several accounts on one server, choose one with \`gt auth switch\`.`,
      });
    const baseUrl = login.url.replace(/\/+$/, "");
    if (hostOnly) return { command: "gt" as const, login: login.user, repository: "", baseUrl };
    const repositoryPath = ForgejoCli.relativeRepositoryPath({
      input,
      referenceRemote,
      remote,
      loginUrl: login.url,
    });
    // A `GITEA_TOKEN` row names no account until gt verifies it.
    const owner =
      repositoryPath.includes("/") || login.user
        ? login.user
        : yield* getAccount({ cwd: input.cwd, baseUrl });
    const repository = repositoryPath.includes("/") ? repositoryPath : `${owner}/${repositoryPath}`;
    if (!/^[^/\s]+\/[^/\s]+$/.test(repository))
      return yield* new ForgejoCli.ForgejoCliError({
        command: "gt",
        cwd: input.cwd,
        detail: "Specify a Gitea repository as owner/repository or its full server URL.",
      });
    return { command: "gt" as const, login: login.user, repository, baseUrl };
  });

  const resolveRepository = (input: ForgejoCli.ForgejoRepositoryInput) => resolveTarget(input);
  const api = Effect.fn("GiteaCli.api")(function* (input: ForgejoCli.ForgejoApiInput) {
    const target = yield* resolveTarget(
      input,
      input.path.replace(/^\/+/, "") === "user" && (!input.method || input.method === "GET"),
    );
    const body =
      input.body === undefined
        ? undefined
        : yield* encodeApiBody(input.body).pipe(
            Effect.mapError(
              (cause) =>
                new ForgejoCli.ForgejoCliError({
                  command: "gt",
                  cwd: input.cwd,
                  detail: "Could not encode the Gitea request body.",
                  cause,
                }),
            ),
          );
    return yield* request({
      cwd: input.cwd,
      baseUrl: target.baseUrl,
      user: target.login,
      path: ForgejoCli.apiPath(input, target.repository),
      ...(input.method === undefined ? {} : { method: input.method }),
      ...(body === undefined ? {} : { body }),
    });
  });

  return ForgejoCli.ForgejoCli.of({
    execute,
    listLogins,
    getAccount,
    resolveRepository,
    api,
  });
});

export const layer = Layer.effect(ForgejoCli.ForgejoCli, make);
