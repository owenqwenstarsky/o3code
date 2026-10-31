import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as Crypto from "effect/Crypto";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronProtocol from "../electron/ElectronProtocol.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import { installDesktopIpcHandlers } from "../ipc/DesktopIpcHandlers.ts";
import * as DesktopAppIdentity from "./DesktopAppIdentity.ts";
import * as DesktopLaunchLinks from "./DesktopLaunchLinks.ts";
import * as DesktopApplicationMenu from "../window/DesktopApplicationMenu.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as PreviewPasskeys from "../preview/Passkeys.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopLegacyLocalStorage from "./DesktopLegacyLocalStorage.ts";
import * as DesktopLifecycle from "./DesktopLifecycle.ts";
import * as DesktopLinuxUrlHandler from "./DesktopLinuxUrlHandler.ts";
import * as DesktopObservability from "./DesktopObservability.ts";
import * as DesktopPreReadyPlatform from "./DesktopPreReadyPlatform.ts";
import * as DesktopShutdown from "./DesktopShutdown.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopShellEnvironment from "../shell/DesktopShellEnvironment.ts";
import * as DesktopState from "./DesktopState.ts";
import * as DesktopUpdates from "../updates/DesktopUpdates.ts";
import * as DesktopSnapShot from "../snapShot/DesktopSnapShot.ts";
import * as DesktopRendererHistory from "../telemetry/DesktopRendererHistory.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";

const makeDesktopRunId = Crypto.Crypto.pipe(
  Effect.flatMap((crypto) => crypto.randomUUIDv4()),
  Effect.map((value) => value.replaceAll("-", "").slice(0, 12)),
);

const { logInfo: logBootstrapInfo } = DesktopObservability.makeComponentLogger("desktop-bootstrap");

const { logInfo: logStartupInfo, logError: logStartupError } =
  DesktopObservability.makeComponentLogger("desktop-startup");

const handleFatalStartupError = Effect.fn("desktop.startup.handleFatalStartupError")(function* (
  stage: string,
  error: unknown,
): Effect.fn.Return<
  void,
  never,
  | DesktopShutdown.DesktopShutdown
  | DesktopState.DesktopState
  | ElectronApp.ElectronApp
  | ElectronDialog.ElectronDialog
> {
  const shutdown = yield* DesktopShutdown.DesktopShutdown;
  const state = yield* DesktopState.DesktopState;
  const electronApp = yield* ElectronApp.ElectronApp;
  const electronDialog = yield* ElectronDialog.ElectronDialog;
  const message = error instanceof Error ? error.message : String(error);
  const detail =
    error instanceof Error && typeof error.stack === "string" ? `\n${error.stack}` : "";
  yield* logStartupError("fatal startup error", {
    stage,
    message,
    ...(detail.length > 0 ? { detail } : {}),
  });
  const wasQuitting = yield* Ref.getAndSet(state.quitting, true);
  if (!wasQuitting) {
    yield* electronDialog.showErrorBox(
      "T3 Code failed to start",
      `Stage: ${stage}\n${message}${detail}`,
    );
  }
  yield* shutdown.request;
  yield* electronApp.quit;
});

const fatalStartupCause = <E>(stage: string, cause: Cause.Cause<E>) =>
  handleFatalStartupError(stage, Cause.pretty(cause)).pipe(Effect.andThen(Effect.failCause(cause)));

const bootstrap = Effect.gen(function* () {
  const state = yield* DesktopState.DesktopState;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const snapShot = yield* DesktopSnapShot.DesktopSnapShot;
  yield* logBootstrapInfo("bootstrap start");

  const electronProtocol = yield* ElectronProtocol.ElectronProtocol;
  yield* electronProtocol.registerDesktopProtocol({
    scheme: ElectronProtocol.getDesktopScheme(environment.isDevelopment),
    ...(environment.isDevelopment
      ? { targetOrigin: Option.getOrThrow(environment.devServerUrl) }
      : { assetDirectory: environment.clientAssetsDir }),
  });
  yield* installDesktopIpcHandlers();
  yield* logBootstrapInfo("bootstrap ipc handlers registered");
  // Before any window: the preload merges these items before the app reads storage.
  yield* (yield* DesktopLegacyLocalStorage.DesktopLegacyLocalStorage).load(
    yield* (yield* DesktopAppIdentity.DesktopAppIdentity).resolveUserDataPath,
  );

  yield* snapShot.initialize;

  if (!(yield* Ref.get(state.quitting))) {
    yield* desktopWindow.createMainIfMissing;
  }
}).pipe(Effect.withSpan("desktop.bootstrap"));

const startup = Effect.gen(function* () {
  const appIdentity = yield* DesktopAppIdentity.DesktopAppIdentity;
  const applicationMenu = yield* DesktopApplicationMenu.DesktopApplicationMenu;
  const electronApp = yield* ElectronApp.ElectronApp;
  const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
  const linuxUrlHandler = yield* DesktopLinuxUrlHandler.DesktopLinuxUrlHandler;
  const launchLinks = yield* DesktopLaunchLinks.DesktopLaunchLinks;
  const shellEnvironment = yield* DesktopShellEnvironment.DesktopShellEnvironment;
  const desktopSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const preReadyElectronOptions = yield* DesktopPreReadyPlatform.DesktopPreReadyElectronOptions;
  const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
  const updates = yield* DesktopUpdates.DesktopUpdates;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const previewPasskeys = yield* PreviewPasskeys.PreviewPasskeys;

  yield* shellEnvironment.installIntoProcess;
  const hasCommandLinePasswordStore =
    preReadyElectronOptions.linuxPasswordStoreCommandLine !== null;
  const linuxElectronOptions =
    environment.platform === "linux" && !hasCommandLinePasswordStore
      ? DesktopPreReadyPlatform.resolveEarlyLinuxElectronOptionsFromProcess(
          yield* HostProcess.HomeDirectory,
        )
      : preReadyElectronOptions.linux;
  if (linuxElectronOptions !== null && !hasCommandLinePasswordStore) {
    if (
      linuxElectronOptions.passwordStore !== null ||
      preReadyElectronOptions.linux?.passwordStore !== null
    ) {
      yield* electronApp.removeCommandLineSwitch("password-store");
    }
    if (linuxElectronOptions.passwordStore !== null) {
      yield* electronApp.appendCommandLineSwitch(
        "password-store",
        linuxElectronOptions.passwordStore,
      );
    }
  }
  const userDataPath = yield* appIdentity.resolveUserDataPath;
  yield* electronApp.setPath("userData", userDataPath);
  yield* logStartupInfo("runtime logging configured", { logDir: environment.logDir });
  yield* desktopSettings.load;

  if (linuxElectronOptions !== null) {
    yield* logStartupInfo("linux password store configured", {
      passwordStore: hasCommandLinePasswordStore
        ? "command-line"
        : (linuxElectronOptions.passwordStore ?? "electron-default"),
      xdgCurrentDesktop: process.env.XDG_CURRENT_DESKTOP ?? null,
      xdgSessionDesktop: process.env.XDG_SESSION_DESKTOP ?? null,
    });
  }

  yield* appIdentity.configure;
  yield* lifecycle.register;
  yield* launchLinks.configure;

  yield* electronApp.whenReady.pipe(
    Effect.withSpan("desktop.electron.whenReady"),
    Effect.catchCause((cause) => fatalStartupCause("whenReady", cause)),
  );
  yield* logStartupInfo("app ready");
  if (environment.platform === "linux") {
    const selectedBackend = yield* safeStorage.selectedStorageBackend;
    yield* logStartupInfo("safe storage ready", {
      backend: Option.getOrElse(selectedBackend, () => "unknown"),
    });
  }
  yield* appIdentity.configure;
  yield* previewPasskeys.configure;
  yield* applicationMenu.configure;
  yield* updates.configure;
  yield* linuxUrlHandler.register;
  yield* bootstrap.pipe(Effect.catchCause((cause) => fatalStartupCause("bootstrap", cause)));
}).pipe(Effect.withSpan("desktop.startup"));

const scopedProgram = Effect.scoped(
  Effect.gen(function* () {
    const runId = yield* makeDesktopRunId;
    yield* Effect.annotateLogsScoped({ scope: "desktop", runId });
    yield* Effect.annotateCurrentSpan({ scope: "desktop", runId });

    const shutdown = yield* DesktopShutdown.DesktopShutdown;
    const rendererHistory = yield* DesktopRendererHistory.DesktopRendererHistory;

    yield* Effect.addFinalizer(() =>
      rendererHistory.shutdown.pipe(Effect.ensuring(shutdown.markComplete)),
    );

    yield* startup;
    yield* shutdown.awaitRequest;
  }),
);

export const program = scopedProgram.pipe(Effect.withSpan("desktop.app"));
