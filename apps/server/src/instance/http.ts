import {
  INSTANCE_API_VERSION,
  InstanceAdminAuth,
  InstanceBadRequestError,
  InstanceForbiddenError,
  InstanceHttpApi,
  InstanceInternalError,
  InstanceNotFoundError,
  InstancePrincipal,
  InstanceUnauthorizedError,
  InstanceUserAuth,
  InstanceUserId,
  InstanceWorkspaceAuth,
  InstanceWorkspacePrincipal,
} from "@t3tools/contracts/instance";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpServerRequest } from "effect/http";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import packageJson from "../../package.json" with { type: "json" };
import { deriveAuthClientMetadata } from "../auth/utils.ts";
import { InstanceAuth } from "./InstanceAuth.ts";
import { InstanceConfig } from "./InstanceConfig.ts";
import { InstanceSettings } from "./InstanceSettings.ts";
import { InstanceStore, type InstanceStoreError } from "./InstanceStore.ts";
import { InstanceUsers } from "./InstanceUsers.ts";
import { Workspaces } from "./Workspaces.ts";
import { WORKSPACE_TOOLS } from "./WorkspaceTools.ts";

const encodeDetail = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const internal = (cause: unknown) =>
  Effect.logError("Instance request failed.", { cause }).pipe(
    Effect.andThen(
      Effect.fail(new InstanceInternalError({ message: "The instance hit an internal error." })),
    ),
  );

/** Store failures become a 500 without leaking the cause. */
const orInternal = <A, E, R>(effect: Effect.Effect<A, E | InstanceStoreError, R>) =>
  effect.pipe(Effect.catchTags({ InstanceStoreError: internal }));

const requestIp = Effect.map(
  HttpServerRequest.HttpServerRequest,
  (request) => deriveAuthClientMetadata({ request }).ipAddress ?? null,
);

const layerUserAuth = Layer.effect(
  InstanceUserAuth,
  Effect.gen(function* () {
    const auth = yield* InstanceAuth;
    return (httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const principal = yield* orInternal(auth.authenticate(request.headers.authorization));
        return yield* httpEffect.pipe(Effect.provideService(InstancePrincipal, principal));
      });
  }),
);

const layerAdminAuth = Layer.effect(
  InstanceAdminAuth,
  Effect.gen(function* () {
    const auth = yield* InstanceAuth;
    return (httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const principal = yield* orInternal(auth.authenticate(request.headers.authorization));
        if (principal.user.role !== "admin") {
          return yield* new InstanceForbiddenError({ message: "This needs an admin account." });
        }
        return yield* httpEffect.pipe(Effect.provideService(InstancePrincipal, principal));
      });
  }),
);

const layerWorkspaceAuth = Layer.effect(
  InstanceWorkspaceAuth,
  Effect.gen(function* () {
    const workspaces = yield* Workspaces;
    return (httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const header = request.headers.authorization ?? "";
        const credential = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
        const separator = credential.indexOf(":");
        const userId = separator > 0 ? credential.slice(0, separator) : "";
        const secret = separator > 0 ? credential.slice(separator + 1) : "";
        const valid =
          userId.length > 0 &&
          secret.length > 0 &&
          (yield* orInternal(workspaces.verifySecret(userId, secret)));
        if (!valid) {
          return yield* new InstanceUnauthorizedError({
            reason: "invalid_credentials",
            message: "Unknown workspace credentials.",
          });
        }
        return yield* httpEffect.pipe(
          Effect.provideService(InstanceWorkspacePrincipal, {
            userId: InstanceUserId.make(userId),
          }),
        );
      });
  }),
);

const layerPublic = HttpApiBuilder.group(
  InstanceHttpApi,
  "public",
  Effect.fnUntraced(function* (handlers) {
    const auth = yield* InstanceAuth;
    const settings = yield* InstanceSettings;
    return handlers
      .handle("descriptor", () =>
        orInternal(
          settings.get.pipe(
            Effect.map((current) => ({
              kind: "o3-instance" as const,
              apiVersion: INSTANCE_API_VERSION,
              name: current.name,
              serverVersion: packageJson.version,
            })),
          ),
        ),
      )
      .handle(
        "login",
        Effect.fn("instance.login")(function* (args) {
          const request = yield* HttpServerRequest.HttpServerRequest;
          return yield* orInternal(
            auth.login({
              email: args.payload.email,
              password: args.payload.password,
              clientKind: args.payload.clientKind,
              deviceLabel: args.payload.deviceLabel,
              request,
            }),
          );
        }),
      );
  }),
);

const layerAccount = HttpApiBuilder.group(
  InstanceHttpApi,
  "account",
  Effect.fnUntraced(function* (handlers) {
    const auth = yield* InstanceAuth;
    const workspaces = yield* Workspaces;
    const settings = yield* InstanceSettings;

    const requireWorkspace = (userId: string) =>
      orInternal(workspaces.get(userId)).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new InstanceNotFoundError({ message: "You don't have a workspace yet." }),
              ),
            onSome: Effect.succeed,
          }),
        ),
      );

    return handlers
      .handle(
        "me",
        Effect.fn("instance.me")(function* () {
          const principal = yield* InstancePrincipal;
          const workspace = yield* orInternal(workspaces.get(principal.user.id));
          return {
            user: principal.user,
            workspace: Option.getOrNull(workspace),
            sessionId: principal.sessionId,
          };
        }),
      )
      .handle(
        "logout",
        Effect.fn("instance.logout")(function* () {
          const principal = yield* InstancePrincipal;
          yield* auth.logout(principal.sessionId, principal.user.id);
          return { ok: true };
        }),
      )
      .handle(
        "changePassword",
        Effect.fn("instance.changePassword")(function* (args) {
          const principal = yield* InstancePrincipal;
          return yield* orInternal(
            auth.changePassword({
              principal,
              currentPassword: args.payload.currentPassword,
              newPassword: args.payload.newPassword,
              ipAddress: yield* requestIp,
            }),
          ).pipe(
            // A wrong current password must not look like a dead session to the client.
            Effect.catchTags({
              InstanceUnauthorizedError: (error) =>
                Effect.fail(new InstanceBadRequestError({ message: error.message })),
            }),
          );
        }),
      )
      .handle(
        "sessions",
        Effect.fn("instance.sessions")(function* () {
          const principal = yield* InstancePrincipal;
          return { sessions: yield* auth.listSessions(principal.user.id, principal.sessionId) };
        }),
      )
      .handle(
        "revokeSession",
        Effect.fn("instance.revokeSession")(function* (args) {
          const principal = yield* InstancePrincipal;
          const revoked = yield* auth.revokeSession(principal.user.id, args.params.sessionId);
          if (!revoked) return yield* new InstanceNotFoundError({ message: "Session not found." });
          yield* settings.audit({
            actorUserId: principal.user.id,
            actorEmail: principal.user.email,
            action: "auth.session_revoked",
            targetUserId: principal.user.id,
            targetEmail: principal.user.email,
          });
          return { ok: true };
        }),
      )
      .handle(
        "workspace",
        Effect.fn("instance.workspace")(function* () {
          const principal = yield* InstancePrincipal;
          return yield* requireWorkspace(principal.user.id);
        }),
      )
      .handle(
        "workspaceToken",
        Effect.fn("instance.workspaceToken")(function* () {
          const principal = yield* InstancePrincipal;
          const workspace = yield* requireWorkspace(principal.user.id);
          const issued = yield* auth.issueWorkspaceToken(principal).pipe(
            Effect.catchTags({
              InstanceUnauthorizedError: (error) =>
                Effect.fail(new InstanceForbiddenError({ message: error.message })),
            }),
          );
          return { ...issued, workspace };
        }),
      )
      .handle(
        "restartWorkspace",
        Effect.fn("instance.restartWorkspace")(function* () {
          const principal = yield* InstancePrincipal;
          const workspace = yield* orInternal(workspaces.action(principal.user.id, "restart"));
          yield* settings.audit({
            actorUserId: principal.user.id,
            actorEmail: principal.user.email,
            action: "workspace.restart",
            targetUserId: principal.user.id,
            targetEmail: principal.user.email,
          });
          return workspace;
        }),
      );
  }),
);

const layerAdmin = HttpApiBuilder.group(
  InstanceHttpApi,
  "admin",
  Effect.fnUntraced(function* (handlers) {
    const users = yield* InstanceUsers;
    const auth = yield* InstanceAuth;
    const workspaces = yield* Workspaces;
    const settings = yield* InstanceSettings;
    const store = yield* InstanceStore;
    const config = yield* InstanceConfig;

    const audit = Effect.fn("instance.admin.audit")(function* (
      action: string,
      targetUserId: string | null,
      detail?: unknown,
    ) {
      const principal = yield* InstancePrincipal;
      const target =
        targetUserId === null
          ? Option.none()
          : yield* store.getUser(targetUserId).pipe(Effect.option, Effect.map(Option.flatten));
      yield* settings.audit({
        actorUserId: principal.user.id,
        actorEmail: principal.user.email,
        action,
        targetUserId,
        targetEmail: Option.match(target, { onNone: () => null, onSome: (user) => user.email }),
        detail: detail === undefined ? null : encodeDetail(detail),
        ipAddress: yield* requestIp,
      });
    });

    return handlers
      .handle("overview", () =>
        orInternal(
          Effect.gen(function* () {
            const current = yield* settings.get;
            const all = yield* store.listUsers();
            const allWorkspaces = [...(yield* workspaces.list).values()];
            return {
              name: current.name,
              serverVersion: packageJson.version,
              users: all.length,
              admins: all.filter((user) => user.role === "admin").length,
              disabledUsers: all.filter((user) => user.disabledAt !== null).length,
              workspacesRunning: allWorkspaces.filter((workspace) => workspace.status === "running")
                .length,
              workspacesTotal: allWorkspaces.length,
              runtime: yield* workspaces.runtimeInfo,
              tailscale: {
                mode: config.tailscale.mode,
                tag: config.tailscale.mode === "none" ? null : config.tailscaleTag,
                instanceUrl: yield* workspaces.instanceUrl,
              },
            };
          }),
        ),
      )
      .handle("listUsers", () =>
        orInternal(users.list.pipe(Effect.map((list) => ({ users: list })))),
      )
      .handle(
        "createUser",
        Effect.fn("instance.admin.createUser")(function* (args) {
          const principal = yield* InstancePrincipal;
          return yield* orInternal(users.create(principal, args.payload));
        }),
      )
      .handle("getUser", (args) => orInternal(users.get(args.params.userId)))
      .handle(
        "updateUser",
        Effect.fn("instance.admin.updateUser")(function* (args) {
          const principal = yield* InstancePrincipal;
          return yield* orInternal(users.update(principal, args.params.userId, args.payload));
        }),
      )
      .handle(
        "resetPassword",
        Effect.fn("instance.admin.resetPassword")(function* (args) {
          const principal = yield* InstancePrincipal;
          const temporaryPassword = yield* orInternal(
            users.resetPassword(principal, args.params.userId),
          );
          return { temporaryPassword };
        }),
      )
      .handle(
        "deleteUser",
        Effect.fn("instance.admin.deleteUser")(function* (args) {
          const principal = yield* InstancePrincipal;
          yield* orInternal(users.remove(principal, args.params.userId, args.payload.deleteData));
          return { ok: true };
        }),
      )
      .handle(
        "userSessions",
        Effect.fn("instance.admin.userSessions")(function* (args) {
          yield* orInternal(users.get(args.params.userId));
          return { sessions: yield* auth.listSessions(args.params.userId, null) };
        }),
      )
      .handle(
        "revokeUserSession",
        Effect.fn("instance.admin.revokeUserSession")(function* (args) {
          const revoked = yield* auth.revokeSession(args.params.userId, args.params.sessionId);
          if (!revoked) return yield* new InstanceNotFoundError({ message: "Session not found." });
          yield* orInternal(audit("auth.session_revoked", args.params.userId));
          return { ok: true };
        }),
      )
      .handle(
        "workspaceAction",
        Effect.fn("instance.admin.workspaceAction")(function* (args) {
          const workspace = yield* orInternal(
            workspaces.action(args.params.userId, args.params.action),
          );
          yield* orInternal(audit(`workspace.${args.params.action}`, args.params.userId));
          return workspace;
        }),
      )
      .handle(
        "updateWorkspace",
        Effect.fn("instance.admin.updateWorkspace")(function* (args) {
          const workspace = yield* orInternal(workspaces.update(args.params.userId, args.payload));
          yield* orInternal(audit("workspace.updated", args.params.userId, args.payload));
          return workspace;
        }),
      )
      .handle("workspaceLogs", (args) =>
        orInternal(workspaces.logs(args.params.userId).pipe(Effect.map((text) => ({ text })))),
      )
      .handle("tools", () => Effect.succeed({ tools: WORKSPACE_TOOLS }))
      .handle("settings", () => orInternal(settings.get))
      .handle(
        "updateSettings",
        Effect.fn("instance.admin.updateSettings")(function* (args) {
          const next = yield* orInternal(settings.update(args.payload));
          yield* orInternal(audit("instance.settings_updated", null, args.payload));
          return next;
        }),
      )
      .handle(
        "upgradeAllWorkspaces",
        Effect.fn("instance.admin.upgradeAllWorkspaces")(function* () {
          const recreated = yield* orInternal(workspaces.upgradeAll);
          yield* orInternal(audit("workspace.upgrade_all", null, { recreated }));
          return { recreated };
        }),
      )
      .handle("audit", (args) =>
        orInternal(
          Effect.gen(function* () {
            const limit = Math.min(Math.max(args.query.limit ?? 50, 1), 200);
            const events = yield* store.listAudit({ beforeId: args.query.beforeId, limit });
            const last = events.at(-1);
            return {
              events,
              nextBeforeId: events.length === limit && last ? last.id : null,
            };
          }),
        ),
      );
  }),
);

const layerInternal = HttpApiBuilder.group(
  InstanceHttpApi,
  "internal",
  Effect.fnUntraced(function* (handlers) {
    const auth = yield* InstanceAuth;
    return handlers.handle(
      "introspect",
      Effect.fn("instance.introspect")(function* (args) {
        const workspace = yield* InstanceWorkspacePrincipal;
        return yield* orInternal(
          auth.introspect({ token: args.payload.token, workspaceUserId: workspace.userId }),
        );
      }),
    );
  }),
);

export const layer = HttpApiBuilder.layer(InstanceHttpApi).pipe(
  Layer.provide([layerPublic, layerAccount, layerAdmin, layerInternal]),
  Layer.provide([layerUserAuth, layerAdminAuth, layerWorkspaceAuth]),
);
