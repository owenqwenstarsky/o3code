import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
} from "../connection/catalog.ts";
import {
  BearerConnectionTarget,
  ConnectionTransientError,
  PrimaryConnectionTarget,
} from "../connection/model.ts";
import {
  PullRequestRoutingPermissions,
  makePullRequestRoutingPermissions,
} from "../connection/pullRequestRoutingPermissions.ts";
import {
  ConnectionCatalogDocument,
  EMPTY_CONNECTION_CATALOG_DOCUMENT,
  catalogRoutes,
  setRoutesInCatalog,
  registerConnectionInCatalog,
  removeConnectionFromCatalog,
  setConnectionEnabledInCatalog,
} from "./storageDocument.ts";

const decodeConnectionCatalogDocument = Schema.decodeUnknownEffect(ConnectionCatalogDocument);

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const decodeCatalogDocument = Schema.decodeUnknownSync(ConnectionCatalogDocument);
const encodeBearerTarget = Schema.encodeSync(BearerConnectionTarget);
const encodeBearerProfile = Schema.encodeSync(BearerConnectionProfile);

const TAILNET_TARGET = new BearerConnectionTarget({
  environmentId: ENVIRONMENT_ID,
  label: "Remote",
  connectionId: "bearer-tailnet",
});
const TAILNET_PROFILE = new BearerConnectionProfile({
  connectionId: TAILNET_TARGET.connectionId,
  environmentId: ENVIRONMENT_ID,
  label: TAILNET_TARGET.label,
  httpBaseUrl: "http://remote.tailnet.ts.net",
  wsBaseUrl: "ws://remote.tailnet.ts.net",
});
const BEARER_TARGET = new BearerConnectionTarget({
  environmentId: ENVIRONMENT_ID,
  label: "Remote",
  connectionId: "bearer-1",
});
const BEARER_PROFILE = new BearerConnectionProfile({
  connectionId: BEARER_TARGET.connectionId,
  environmentId: ENVIRONMENT_ID,
  label: BEARER_TARGET.label,
  httpBaseUrl: "https://remote.example.test",
  wsBaseUrl: "wss://remote.example.test",
});
const BEARER_CREDENTIAL = new BearerConnectionCredential({
  token: "bearer-token",
});
describe("ConnectionCatalogDocument", () => {
  it.effect("persists explicit GitHub trust and forgets it when a connection is removed", () =>
    Effect.gen(function* () {
      let document = EMPTY_CONNECTION_CATALOG_DOCUMENT;
      const entry = { target: BEARER_TARGET, profile: Option.some(BEARER_PROFILE), enabled: true };
      const storage = {
        read: Effect.sync(() => document.githubRoutingPermissions ?? []),
        write: (githubRoutingPermissions: NonNullable<typeof document.githubRoutingPermissions>) =>
          Effect.gen(function* () {
            document = yield* decodeConnectionCatalogDocument({
              ...document,
              githubRoutingPermissions,
            }).pipe(Effect.orDie);
          }),
      };
      const permissions = yield* makePullRequestRoutingPermissions(storage);
      expect(yield* permissions.get(entry)).toBe("off");
      yield* permissions.set(entry, "read");
      const restarted = yield* makePullRequestRoutingPermissions(storage);
      expect(yield* restarted.get(entry)).toBe("read");

      const changedEndpoint = {
        ...entry,
        profile: Option.some(
          new BearerConnectionProfile({
            ...BEARER_PROFILE,
            httpBaseUrl: "https://different.example.test",
          }),
        ),
      };
      expect(yield* restarted.get(changedEndpoint)).toBe("off");
      expect(
        yield* restarted.get({
          ...entry,
          profile: Option.some(
            new BearerConnectionProfile({
              ...BEARER_PROFILE,
              wsBaseUrl: "wss://different.example.test",
            }),
          ),
        }),
      ).toBe("off");
      yield* restarted.set(entry, "read-write");
      expect(yield* restarted.get(entry)).toBe("read-write");
      yield* restarted.forget(ENVIRONMENT_ID);
      expect(yield* restarted.get(entry)).toBe("off");
      const afterRemoval = yield* makePullRequestRoutingPermissions(storage);
      expect(yield* afterRemoval.get(entry)).toBe("off");

      yield* permissions.set(entry, "read");
      document = removeConnectionFromCatalog(document, ENVIRONMENT_ID);
      const afterCatalogRemoval = yield* makePullRequestRoutingPermissions(storage);
      expect(yield* afterCatalogRemoval.get(entry)).toBe("off");
    }),
  );

  it.effect("requires explicit trust for primary and bearer connections independently", () =>
    Effect.gen(function* () {
      const permissions = yield* makePullRequestRoutingPermissions({
        read: Effect.succeed([]),
        write: () => Effect.void,
      });
      const entries = [
        {
          target: new PrimaryConnectionTarget({
            environmentId: ENVIRONMENT_ID,
            label: "Local",
            httpBaseUrl: "http://localhost:3000",
            wsBaseUrl: "ws://localhost:3000",
          }),
          profile: Option.none(),
          enabled: true,
        },
        { target: BEARER_TARGET, profile: Option.some(BEARER_PROFILE), enabled: true },
      ];
      for (const entry of entries) {
        expect(yield* permissions.get(entry)).toBe("off");
        yield* permissions.set(entry, "read");
        expect(yield* permissions.get(entry)).toBe("read");
        yield* permissions.set(entry, "off");
        expect(yield* permissions.get(entry)).toBe("off");
      }
    }),
  );

  it.effect("does not enable GitHub routing when permission persistence fails", () =>
    Effect.gen(function* () {
      const entry = { target: BEARER_TARGET, profile: Option.some(BEARER_PROFILE), enabled: true };
      expect(yield* (yield* PullRequestRoutingPermissions).get(entry)).toBe("off");
      const permissions = yield* makePullRequestRoutingPermissions({
        read: Effect.succeed([]),
        write: () =>
          Effect.fail(
            new ConnectionTransientError({
              reason: "remote-unavailable",
              detail: "storage unavailable",
            }),
          ),
      });
      yield* permissions.set(entry, "read-write").pipe(Effect.flip);
      expect(yield* permissions.get(entry)).toBe("off");
    }),
  );

  it("replaces obsolete connection metadata when an environment gets a new route", () => {
    const bearer = registerConnectionInCatalog(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
      new BearerConnectionRegistration({
        target: BEARER_TARGET,
        profile: BEARER_PROFILE,
        credential: BEARER_CREDENTIAL,
      }),
    );
    const tailnet = registerConnectionInCatalog(
      bearer,
      new BearerConnectionRegistration({
        target: TAILNET_TARGET,
        profile: TAILNET_PROFILE,
        credential: BEARER_CREDENTIAL,
      }),
    );

    expect(tailnet.targets).toEqual([TAILNET_TARGET]);
    expect(tailnet.profiles).toEqual([TAILNET_PROFILE]);
    expect(tailnet.credentials).toEqual([
      { connectionId: TAILNET_TARGET.connectionId, credential: BEARER_CREDENTIAL },
    ]);
  });

  it("removes every catalog record owned by an explicit disconnect", () => {
    const registered = registerConnectionInCatalog(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
      new BearerConnectionRegistration({
        target: BEARER_TARGET,
        profile: BEARER_PROFILE,
        credential: BEARER_CREDENTIAL,
      }),
    );

    expect(removeConnectionFromCatalog(registered, ENVIRONMENT_ID)).toEqual(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
    );
  });

  it("decodes a document written before the disabled list existed", () => {
    const decoded = decodeCatalogDocument({
      schemaVersion: 1,
      targets: [],
      profiles: [],
      credentials: [],
      remoteDpopTokens: [],
    });

    expect(decoded.disabledEnvironmentIds).toEqual([]);
  });

  it("keeps an O3 sign-in saved before several workspaces per user", () => {
    const decoded = decodeCatalogDocument({
      schemaVersion: 1,
      targets: [],
      profiles: [],
      credentials: [],
      disabledEnvironmentIds: [],
      instanceSession: {
        url: "https://o3.tail.ts.net",
        name: "Acme",
        sessionToken: "o3s_session",
        userId: "user-1",
        email: "alice@acme.test",
        environmentId: "environment-workspace",
        workspaceTokenExpiresAt: "2099-01-01T00:00:00.000Z",
        workspaceHttpBaseUrl: "https://o3-alice.tail.ts.net",
      },
    });

    expect(decoded.instanceSession).toMatchObject({
      sessionToken: "o3s_session",
      environmentId: "environment-workspace",
    });
    expect(decoded.instanceSession?.workspaces).toBeUndefined();
  });

  it("drops T3 Connect and SSH routes from a document saved before they were removed", () => {
    const decoded = decodeCatalogDocument({
      schemaVersion: 1,
      targets: [
        { _tag: "RelayConnectionTarget", environmentId: "environment-relay", label: "Relay" },
        {
          _tag: "SshConnectionTarget",
          environmentId: "environment-ssh",
          label: "SSH",
          connectionId: "ssh-1",
        },
        encodeBearerTarget(BEARER_TARGET),
      ],
      profiles: [
        {
          _tag: "SshConnectionProfile",
          connectionId: "ssh-1",
          environmentId: "environment-ssh",
          label: "SSH",
          target: { alias: "work", hostname: "work.example.test", username: "maria", port: 22 },
        },
        encodeBearerProfile(BEARER_PROFILE),
      ],
      credentials: [],
      remoteDpopTokens: [{ environmentId: "environment-relay", accessToken: "dpop-token" }],
      disabledEnvironmentIds: [],
    });

    expect(decoded.targets).toEqual([BEARER_TARGET]);
    expect(decoded.profiles).toEqual([BEARER_PROFILE]);
  });

  it("switches a saved environment off and back on without touching its records", () => {
    const registered = registerConnectionInCatalog(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
      new BearerConnectionRegistration({
        target: BEARER_TARGET,
        profile: BEARER_PROFILE,
        credential: BEARER_CREDENTIAL,
      }),
    );

    const disabled = setConnectionEnabledInCatalog(registered, ENVIRONMENT_ID, false);
    expect(disabled.disabledEnvironmentIds).toEqual([ENVIRONMENT_ID]);
    expect(disabled.targets).toEqual(registered.targets);
    expect(disabled.credentials).toEqual(registered.credentials);
    expect(
      setConnectionEnabledInCatalog(disabled, ENVIRONMENT_ID, false).disabledEnvironmentIds,
    ).toEqual([ENVIRONMENT_ID]);

    expect(
      setConnectionEnabledInCatalog(disabled, ENVIRONMENT_ID, true).disabledEnvironmentIds,
    ).toEqual([]);
    expect(
      registerConnectionInCatalog(
        disabled,
        new BearerConnectionRegistration({
          target: BEARER_TARGET,
          profile: BEARER_PROFILE,
          credential: BEARER_CREDENTIAL,
        }),
      ).disabledEnvironmentIds,
    ).toEqual([ENVIRONMENT_ID]);
    expect(removeConnectionFromCatalog(disabled, ENVIRONMENT_ID).disabledEnvironmentIds).toEqual(
      [],
    );
  });

  it("keeps every route of an environment and drops only a removed route's records", () => {
    const withBearer = registerConnectionInCatalog(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
      new BearerConnectionRegistration({
        target: BEARER_TARGET,
        profile: BEARER_PROFILE,
        credential: BEARER_CREDENTIAL,
      }),
    );
    const withTailnet = registerConnectionInCatalog(
      withBearer,
      new BearerConnectionRegistration({
        target: TAILNET_TARGET,
        profile: TAILNET_PROFILE,
        credential: BEARER_CREDENTIAL,
      }),
      [BEARER_TARGET, TAILNET_TARGET],
    );
    expect(catalogRoutes(withTailnet, ENVIRONMENT_ID)).toEqual([BEARER_TARGET, TAILNET_TARGET]);
    expect(withTailnet.credentials).toHaveLength(2);

    const tailnetOnly = setRoutesInCatalog(withTailnet, ENVIRONMENT_ID, [TAILNET_TARGET]);
    expect(tailnetOnly.targets).toEqual([TAILNET_TARGET]);
    expect(tailnetOnly.profiles).toEqual([TAILNET_PROFILE]);
    expect(tailnetOnly.credentials).toHaveLength(1);

    const bearerOnly = setRoutesInCatalog(withTailnet, ENVIRONMENT_ID, [BEARER_TARGET]);
    expect(bearerOnly.profiles).toEqual([BEARER_PROFILE]);
    expect(bearerOnly.credentials).toHaveLength(1);
  });

  it("keeps an environment's position in the catalog when its routes change", () => {
    const other = new BearerConnectionTarget({
      environmentId: EnvironmentId.make("environment-2"),
      label: "Other",
      connectionId: "bearer-other",
    });
    const document = {
      ...EMPTY_CONNECTION_CATALOG_DOCUMENT,
      targets: [TAILNET_TARGET, other],
    };
    expect(
      setRoutesInCatalog(document, ENVIRONMENT_ID, [BEARER_TARGET, TAILNET_TARGET]).targets,
    ).toEqual([BEARER_TARGET, TAILNET_TARGET, other]);
  });
});
