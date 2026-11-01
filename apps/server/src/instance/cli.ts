import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import { Command, Flag, GlobalFlag } from "effect/cli";
import * as CliError from "effect/cli/CliError";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import {
  authLocationFlags,
  type CliAuthLocationFlags,
  resolveCliAuthConfig,
  resolveServerConfig,
  sharedServerCommandFlags,
} from "../cli/config.ts";
import * as InstanceAuth from "./InstanceAuth.ts";
import * as InstanceConfig from "./InstanceConfig.ts";
import * as InstanceSettings from "./InstanceSettings.ts";
import * as InstanceStore from "./InstanceStore.ts";
import { generateTemporaryPassword, hashPassword } from "./Passwords.ts";
import { runInstanceServer } from "./server.ts";

const serveCommand = Command.make("serve", { ...sharedServerCommandFlags }).pipe(
  Command.withDescription(
    "Run an O3 instance: email and password accounts, the admin panel, and Docker workspaces for each user.",
  ),
  Command.withHandler(
    Effect.fn("instance.serve")(function* (flags) {
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveServerConfig(flags, logLevel, {
        startupPresentation: "headless",
        forceAutoBootstrapProjectFromCwd: false,
      });
      return yield* runInstanceServer.pipe(Effect.provide(ServerConfig.layer(config)));
    }),
  ),
);

/** Offline access to the instance database for recovery, without starting workspaces. */
const runWithStore = Effect.fn("instance.runWithStore")(function* <A, E>(
  flags: CliAuthLocationFlags,
  run: Effect.Effect<A, E, InstanceStore.InstanceStore | InstanceAuth.InstanceAuth>,
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel, { quietLogs: true });
  const layer = InstanceAuth.layer.pipe(
    Layer.provideMerge(InstanceSettings.layer),
    Layer.provideMerge(InstanceStore.layer),
    Layer.provideMerge(InstanceConfig.layerFromEnv),
    Layer.provideMerge(
      SessionStore.layer.pipe(
        Layer.provideMerge(ServerEnvironment.layer),
        Layer.provideMerge(ServerSecretStore.layer),
      ),
    ),
    Layer.provideMerge(SqlitePersistence.layerFromPath(config.dbPath)),
    Layer.provide(ServerConfig.layer(config)),
    Layer.provide(Layer.succeed(References.MinimumLogLevel, "Error")),
  );
  return yield* run.pipe(Effect.provide(layer));
});

const emailFlag = Flag.String("email").pipe(Flag.withDescription("The account's email address."));
const passwordFlag = Flag.String("password").pipe(
  Flag.withDescription("Set this password instead of generating a temporary one."),
  Flag.optional,
);

const resetPasswordCommand = Command.make("reset-password", {
  ...authLocationFlags,
  email: emailFlag,
  password: passwordFlag,
}).pipe(
  Command.withDescription(
    "Reset an account's password and sign it out everywhere. Prints a temporary password unless --password is given.",
  ),
  Command.withHandler((flags) =>
    runWithStore(
      flags,
      Effect.gen(function* () {
        const store = yield* InstanceStore.InstanceStore;
        const auth = yield* InstanceAuth.InstanceAuth;
        const user = yield* store.findUserByEmail(flags.email);
        if (Option.isNone(user)) {
          return yield* new CliError.UserError({
            cause: flags.email,
            userMessage: `No account with email ${flags.email}.`,
          });
        }
        const password = Option.getOrElse(flags.password, generateTemporaryPassword);
        yield* store.updateUser(
          user.value.userId,
          {
            passwordHash: yield* hashPassword(password).pipe(Effect.orDie),
            mustChangePassword: Option.isNone(flags.password),
            disabledAt: null,
          },
          DateTime.formatIso(yield* DateTime.now),
        );
        yield* auth.revokeAllForUser(user.value.userId);
        yield* Console.log(
          Option.isNone(flags.password)
            ? `Temporary password for ${user.value.email}: ${password}\nThey must change it when they sign in.`
            : `Password updated for ${user.value.email}.`,
        );
      }),
    ),
  ),
);

const listCommand = Command.make("list", { ...authLocationFlags }).pipe(
  Command.withDescription("List instance accounts."),
  Command.withHandler((flags) =>
    runWithStore(
      flags,
      Effect.gen(function* () {
        const store = yield* InstanceStore.InstanceStore;
        const users = yield* store.listUsers();
        if (users.length === 0) {
          yield* Console.log(
            "No accounts. Set O3_ADMIN_EMAIL and O3_ADMIN_PASSWORD and start the instance.",
          );
          return;
        }
        for (const user of users) {
          yield* Console.log(
            `${user.email}\t${user.role}${user.disabledAt ? "\tdisabled" : ""}\t${user.name}`,
          );
        }
      }),
    ),
  ),
);

const adminCommand = Command.make("admin").pipe(
  Command.withDescription("Recover instance accounts from the server's terminal."),
  Command.withSubcommands([listCommand, resetPasswordCommand]),
);

export const instanceCommand = Command.make("instance").pipe(
  Command.withDescription("Run and manage an O3 instance."),
  Command.withSubcommands([serveCommand, adminCommand]),
);
