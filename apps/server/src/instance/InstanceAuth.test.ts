import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId } from "@t3tools/contracts";
import { InstanceUserId } from "@t3tools/contracts/instance";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { FetchHttpClient, HttpServerRequest } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { demuxDockerStream } from "./DockerEngine.ts";
import { InstanceAuth } from "./InstanceAuth.ts";
import { InstanceConfig } from "./InstanceConfig.ts";
import { InstanceUsers } from "./InstanceUsers.ts";
import { layerServices } from "./server.ts";
import { slugCandidate } from "./Workspaces.ts";

const layerConfig = Layer.succeed(InstanceConfig, {
  initialName: "Acme",
  initialWorkspaceImage: "o3code/workspace:test",
  bootstrapAdmin: Option.some({
    email: "admin@acme.test",
    password: Redacted.make("admin-password-1"),
  }),
  instanceUrl: Option.some("http://instance.test"),
  runtime: { kind: "static", url: "http://workspace.test", secret: Redacted.make("static") },
  tailscale: { mode: "none" },
  tailscaleTag: "tag:o3-workspace",
});

const layerInstance = layerServices.pipe(
  Layer.provideMerge(layerConfig),
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("instance-test")),
    }),
  ),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "o3-instance-test-" })),
  Layer.provide(FetchHttpClient.layer),
  Layer.provideMerge(NodeServices.layer),
);

const request = () =>
  HttpServerRequest.fromWeb(
    new Request("http://instance.test/o3/api/auth/login", { headers: { "user-agent": "vitest" } }),
  );

const login = (email: string, password: string) =>
  InstanceAuth.pipe(
    Effect.flatMap((auth) =>
      auth.login({
        email,
        password,
        clientKind: "web",
        deviceLabel: undefined,
        request: request(),
      }),
    ),
  );

const bearer = (token: string) => `Bearer ${token}`;

it.layer(layerInstance)("InstanceAuth", (it) => {
  it.effect("seeds the first admin, who must change the bootstrap password", () =>
    Effect.gen(function* () {
      const users = yield* InstanceUsers;
      yield* users.bootstrap;
      yield* users.bootstrap;
      const all = yield* users.list;
      expect(all.map((entry) => [entry.user.email, entry.user.role])).toEqual([
        ["admin@acme.test", "admin"],
      ]);

      const session = yield* login("ADMIN@acme.test", "admin-password-1");
      expect(session.user.mustChangePassword).toBe(true);
      const auth = yield* InstanceAuth;
      const principal = yield* auth.authenticate(bearer(session.sessionToken));
      const refused = yield* auth.issueWorkspaceToken(principal).pipe(Effect.flip);
      expect(refused._tag).toBe("InstanceForbiddenError");
    }),
  );

  it.effect("rejects wrong passwords and rate limits repeated failures per email", () =>
    Effect.gen(function* () {
      const users = yield* InstanceUsers;
      const created = yield* users.create(null, {
        email: "limit@acme.test",
        name: "Limit",
        role: "member",
      });
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const failure = yield* login("limit@acme.test", "wrong").pipe(Effect.flip);
        expect(failure._tag).toBe("InstanceUnauthorizedError");
      }
      const limited = yield* login("limit@acme.test", created.temporaryPassword).pipe(Effect.flip);
      expect(limited._tag).toBe("InstanceRateLimitedError");
    }),
  );

  it.effect("keeps instance sessions and workspace tokens in separate audiences", () =>
    Effect.gen(function* () {
      const users = yield* InstanceUsers;
      const auth = yield* InstanceAuth;
      const created = yield* users.create(
        null,
        { email: "bob@acme.test", name: "Bob", role: "member" },
        { password: "bob-password-1", mustChangePassword: false },
      );
      const session = yield* login("bob@acme.test", "bob-password-1");
      const principal = yield* auth.authenticate(bearer(session.sessionToken));
      const workspace = yield* auth.issueWorkspaceToken(principal);

      const asInstance = yield* auth.authenticate(bearer(workspace.token)).pipe(Effect.flip);
      expect(asInstance._tag).toBe("InstanceUnauthorizedError");
      expect(
        yield* auth.introspect({ token: session.sessionToken, workspaceUserId: created.user.id }),
      ).toEqual({ active: false });

      const active = yield* auth.introspect({
        token: workspace.token,
        workspaceUserId: created.user.id,
      });
      expect(active).toMatchObject({ active: true, userId: created.user.id, role: "member" });

      // Another user's workspace must not accept Bob's token.
      expect(
        yield* auth.introspect({
          token: workspace.token,
          workspaceUserId: InstanceUserId.make("someone-else"),
        }),
      ).toEqual({ active: false });
    }),
  );

  it.effect(
    "ends workspace tokens with the session, a password change, or a disabled account",
    () =>
      Effect.gen(function* () {
        const users = yield* InstanceUsers;
        const auth = yield* InstanceAuth;
        const created = yield* users.create(
          null,
          { email: "carol@acme.test", name: "Carol", role: "admin" },
          { password: "carol-password-1", mustChangePassword: false },
        );
        const introspect = (token: string) =>
          auth.introspect({ token, workspaceUserId: created.user.id });

        // Logout revokes the session's workspace tokens.
        const first = yield* login("carol@acme.test", "carol-password-1");
        const firstPrincipal = yield* auth.authenticate(bearer(first.sessionToken));
        const firstToken = yield* auth.issueWorkspaceToken(firstPrincipal);
        yield* auth.logout(firstPrincipal.sessionId, created.user.id);
        expect(yield* introspect(firstToken.token)).toEqual({ active: false });

        // A password change keeps the current device and signs out the others.
        const current = yield* login("carol@acme.test", "carol-password-1");
        const other = yield* login("carol@acme.test", "carol-password-1");
        const currentPrincipal = yield* auth.authenticate(bearer(current.sessionToken));
        const otherPrincipal = yield* auth.authenticate(bearer(other.sessionToken));
        const currentToken = yield* auth.issueWorkspaceToken(currentPrincipal);
        const otherToken = yield* auth.issueWorkspaceToken(otherPrincipal);
        yield* auth.changePassword({
          principal: currentPrincipal,
          currentPassword: "carol-password-1",
          newPassword: "carol-password-2",
          ipAddress: null,
        });
        expect((yield* introspect(currentToken.token)).active).toBe(true);
        expect(yield* introspect(otherToken.token)).toEqual({ active: false });
        const otherSession = yield* auth.authenticate(bearer(other.sessionToken)).pipe(Effect.flip);
        expect(otherSession._tag).toBe("InstanceUnauthorizedError");

        // Disabling the account ends everything, and the admin rule protects the last admin.
        const admin = yield* users.create(
          null,
          { email: "dave@acme.test", name: "Dave", role: "admin" },
          { password: "dave-password-1", mustChangePassword: false },
        );
        const davePrincipal = yield* auth.authenticate(
          bearer((yield* login("dave@acme.test", "dave-password-1")).sessionToken),
        );
        yield* users.update(davePrincipal, created.user.id, { disabled: true });
        expect(yield* introspect(currentToken.token)).toEqual({ active: false });
        const disabledLogin = yield* login("carol@acme.test", "carol-password-2").pipe(Effect.flip);
        expect(disabledLogin).toMatchObject({ reason: "account_disabled" });

        const selfDisable = yield* users
          .update(davePrincipal, admin.user.id, { disabled: true })
          .pipe(Effect.flip);
        expect(selfDisable._tag).toBe("InstanceBadRequestError");
      }),
  );
});

it("derives workspace slugs from the email's local part", () => {
  expect(slugCandidate("Jane.Doe+work@acme.test")).toBe("jane-doe-work");
  expect(slugCandidate("___@acme.test")).toBe("user");
});

it("demultiplexes Docker's framed log stream", () => {
  const frame = (stream: number, text: string) => {
    const body = Buffer.from(text);
    const header = Buffer.alloc(8);
    header[0] = stream;
    header.writeUInt32BE(body.length, 4);
    return Buffer.concat([header, body]);
  };
  expect(demuxDockerStream(Buffer.concat([frame(1, "out\n"), frame(2, "err\n")]))).toBe(
    "out\nerr\n",
  );
  expect(demuxDockerStream(Buffer.from("plain tty output"))).toBe("plain tty output");
});
