import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as O3Authority from "./O3Authority.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as SessionStore from "./SessionStore.ts";

interface FakeInstance {
  answer: "active" | "inactive" | "other-user" | "down";
  calls: number;
  authorization: string | undefined;
}

const layerFakeInstance = (instance: FakeInstance) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        instance.calls += 1;
        instance.authorization = request.headers.authorization;
        if (instance.answer === "down") {
          return HttpClientResponse.fromWeb(request, new Response("down", { status: 502 }));
        }
        const body =
          instance.answer === "inactive"
            ? { active: false }
            : {
                active: true,
                userId: instance.answer === "other-user" ? "user-2" : "user-1",
                email: "user@acme.test",
                name: "User",
                role: "member",
                sessionId: "instance-session",
                expiresAt: "2099-01-01T00:00:00.000Z",
                label: "Laptop",
              };
        return HttpClientResponse.fromWeb(request, Response.json(body));
      }),
    ),
  );

const layerAuthority = (instance: FakeInstance) =>
  Layer.effect(O3Authority.O3Authority, O3Authority.make).pipe(
    Layer.provideMerge(SessionStore.layer),
    Layer.provide(layerFakeInstance(instance)),
    Layer.provide(SqlitePersistence.layerMemory),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make("workspace-test")),
      }),
    ),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "o3-authority-test-" })),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnv({
          env: {
            T3CODE_O3_INSTANCE_URL: "http://instance.test",
            T3CODE_O3_USER_ID: "user-1",
            T3CODE_O3_WORKSPACE_SECRET: "workspace-secret",
          },
        }),
      ),
    ),
    Layer.provide(NodeServices.layer),
  );

const activeSessionIds = SessionStore.SessionStore.pipe(
  Effect.flatMap((sessions) => sessions.listActive()),
  Effect.map((active) => active.map((session) => session.sessionId)),
);

it.effect(
  "maps a workspace token to one shadow session and revokes it when the instance does",
  () => {
    const instance: FakeInstance = { answer: "active", calls: 0, authorization: undefined };
    return Effect.gen(function* () {
      const authority = yield* O3Authority.O3Authority;
      const first = yield* authority.authenticate("o3w_token");
      const again = yield* authority.authenticate("o3w_token");
      expect(again.sessionId).toBe(first.sessionId);
      expect(first.subject).toBe("o3:user-1");
      expect(instance.calls).toBe(1);
      expect(instance.authorization).toBe("Bearer user-1:workspace-secret");
      expect(yield* activeSessionIds).toEqual([first.sessionId]);

      // A live socket makes no requests; the periodic recheck notices the revocation.
      instance.answer = "inactive";
      yield* TestClock.adjust("31 seconds");
      expect(yield* activeSessionIds).toEqual([]);
      const refused = yield* authority.authenticate("o3w_token").pipe(Effect.flip);
      expect(refused.reason).toBe("inactive");
    }).pipe(Effect.provide(layerAuthority(instance)));
  },
);

it.effect("refuses another user's token and tolerates a brief instance outage", () => {
  const instance: FakeInstance = { answer: "other-user", calls: 0, authorization: undefined };
  return Effect.gen(function* () {
    const authority = yield* O3Authority.O3Authority;
    const foreign = yield* authority.authenticate("o3w_foreign").pipe(Effect.flip);
    expect(foreign.reason).toBe("inactive");

    instance.answer = "active";
    const session = yield* authority.authenticate("o3w_mine");
    instance.answer = "down";
    yield* TestClock.adjust("1 minute");
    expect((yield* authority.authenticate("o3w_mine")).sessionId).toBe(session.sessionId);

    yield* TestClock.adjust("5 minutes");
    const outage = yield* authority.authenticate("o3w_mine").pipe(Effect.flip);
    expect(outage.reason).toBe("unreachable");
  }).pipe(Effect.provide(layerAuthority(instance)));
});
