import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

import * as GiteaCli from "./GiteaCli.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const processOutput = TestSourceControlHost.processOutput;

const row = (
  fields: Partial<GiteaCli.GiteaAuthStatusRow & { readonly credential_store: string }>,
) => ({
  host: "https://git.test/gitea",
  user: "maria",
  active: true,
  method: "token",
  credential_store: "keyring",
  credential_available: true,
  verified: null,
  error: "",
  ...fields,
});

const AUTH_STATUS = encodeJson([
  row({}),
  row({ user: "bot", active: false }),
  row({ host: "https://other.test", user: "gone", credential_available: false }),
  // A GITEA_TOKEN without GITEA_CLI_HOST names no instance.
  row({ host: "", user: "", credential_store: "environment" }),
]);

it("reads gt's usable accounts, keeping each instance's mount and active account", () => {
  assert.deepStrictEqual(GiteaCli.parseGiteaLogins(AUTH_STATUS), [
    {
      name: "maria@https://git.test/gitea",
      url: "https://git.test/gitea",
      user: "maria",
      default: "true",
      valid: "true",
    },
    {
      name: "bot@https://git.test/gitea",
      url: "https://git.test/gitea",
      user: "bot",
      default: "false",
      valid: "true",
    },
  ]);
  assert.deepStrictEqual(GiteaCli.parseGiteaLogins("not json"), []);
});

const apiLayer = (
  respond: () => SourceControlHostOutput,
  seen: Array<{ readonly args: ReadonlyArray<string>; readonly stdin?: string }>,
) =>
  TestSourceControlHost.layer({
    process: {
      run: (input) => {
        assert.strictEqual(input.command, "gt");
        assert.strictEqual(input.env?.GITEA_CLI_ERROR_FORMAT, "json");
        if (input.args[0] === "auth") return Effect.succeed(processOutput(AUTH_STATUS));
        seen.push({
          args: input.args,
          ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
        });
        return Effect.succeed(respond());
      },
    },
  });
type SourceControlHostOutput = ReturnType<typeof processOutput>;

it.effect("sends requests to the remote's instance as its active account", () => {
  const seen: Array<{ readonly args: ReadonlyArray<string>; readonly stdin?: string }> = [];
  return Effect.gen(function* () {
    const cli = yield* GiteaCli.make;
    const repository = yield* cli.resolveRepository({
      cwd: "/repo",
      repository: "https://git.test/gitea/maria/project",
    });
    assert.deepStrictEqual(repository, {
      command: "gt",
      login: "maria",
      repository: "maria/project",
      baseUrl: "https://git.test/gitea",
    });
    yield* cli.api({
      cwd: "/repo",
      repository: "https://git.test/gitea/maria/project",
      path: "repos/maria/project/pulls/42",
      method: "PATCH",
      body: { state: "closed" },
    });
    assert.deepStrictEqual(seen, [
      {
        args: [
          "api",
          "--include",
          "--host",
          "https://git.test/gitea",
          "--user",
          "maria",
          "--method",
          "PATCH",
          "--input",
          "-",
          "repos/maria/project/pulls/42",
        ],
        stdin: '{"state":"closed"}',
      },
    ]);
  }).pipe(
    Effect.provide(
      apiLayer(
        () => processOutput("{}", { stderr: "HTTP/1.1 200 OK\nContent-Type: json\n" }),
        seen,
      ),
    ),
  );
});

it.effect.each([
  {
    name: "a missing pull request",
    exitCode: 1,
    stderr:
      'HTTP/1.1 404 Not Found\n\n{"error":{"code":1,"kind":"failure","message":"not found","status":404}}\n',
    reason: "not-found",
  },
  {
    name: "a rejected credential",
    exitCode: 4,
    stderr: '{"error":{"code":4,"kind":"authentication","message":"token expired"}}\n',
    reason: "authentication",
  },
  {
    name: "a server error",
    exitCode: 1,
    stderr: 'HTTP/1.1 500 Internal Server Error\n\n{"error":{"code":1,"message":"boom"}}\n',
    reason: undefined,
  },
] as const)("reports $name with its reason", ({ exitCode, stderr, reason }) =>
  Effect.gen(function* () {
    const cli = yield* GiteaCli.make;
    const result = yield* cli
      .api({ cwd: "/repo", repository: "https://git.test/gitea/maria/project", path: "user" })
      .pipe(Effect.flip);
    assert.strictEqual(result.command, "gt");
    assert.strictEqual(result.reason, reason);
  }).pipe(
    Effect.provide(
      apiLayer(
        () => processOutput("", { stderr, exitCode: ChildProcessSpawner.ExitCode(exitCode) }),
        [],
      ),
    ),
  ),
);
