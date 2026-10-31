import {
  ContextMenuItemSchema,
  DesktopAppBrandingSchema,
  DesktopThemeSchema,
  EDITORS,
  EditorId,
  PickedThemeFileSchema,
  REMOTE_CAPABLE_EDITOR_IDS,
  SystemSettingsPaneSchema,
  type PickedThemeFile,
} from "@t3tools/contracts";
import { resolveEditorCommand } from "@t3tools/shared/editor";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as ElectronApp from "../../electron/ElectronApp.ts";
import * as ElectronDialog from "../../electron/ElectronDialog.ts";
import * as ElectronMenu from "../../electron/ElectronMenu.ts";
import * as ElectronShell from "../../electron/ElectronShell.ts";
import * as ElectronTheme from "../../electron/ElectronTheme.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as Electron from "electron";
import * as MacPermissions from "../../permissions/MacPermissions.ts";
import { safariPermissionCheck } from "../../preview/BrowserImport/SafariPermission.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

const ContextMenuPosition = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
});

const ContextMenuInput = Schema.Struct({
  items: Schema.Array(ContextMenuItemSchema),
  position: Schema.optionalKey(ContextMenuPosition),
});

export const getAppBranding = DesktopIpc.makeSyncIpcMethod({
  channel: IpcChannels.GET_APP_BRANDING_CHANNEL,
  result: Schema.NullOr(DesktopAppBrandingSchema),
  handler: Effect.fn("desktop.ipc.window.getAppBranding")(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    return environment.branding;
  }),
});

export const getSystemLocale = DesktopIpc.makeSyncIpcMethod({
  channel: IpcChannels.GET_SYSTEM_LOCALE_CHANNEL,
  result: Schema.String,
  handler: Effect.fn("desktop.ipc.window.getSystemLocale")(function* () {
    const electronApp = yield* ElectronApp.ElectronApp;
    return yield* electronApp.systemLocale;
  }),
});

export const getWindowFullscreenState = DesktopIpc.makeSyncIpcMethod({
  channel: IpcChannels.GET_WINDOW_FULLSCREEN_STATE_CHANNEL,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.window.getWindowFullscreenState")(function* () {
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const window = yield* electronWindow.currentMainOrFirst;
    return Option.isSome(window) && window.value.isFullScreen();
  }),
});

export const setTheme = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SET_THEME_CHANNEL,
  payload: DesktopThemeSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.window.setTheme")(function* (theme) {
    const electronTheme = yield* ElectronTheme.ElectronTheme;
    yield* electronTheme.setSource(theme);
  }),
});

export const showContextMenu = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.CONTEXT_MENU_CHANNEL,
  payload: ContextMenuInput,
  result: Schema.NullOr(Schema.String),
  handler: Effect.fn("desktop.ipc.window.showContextMenu")(function* (input) {
    const electronMenu = yield* ElectronMenu.ElectronMenu;
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const window = yield* electronWindow.focusedMainOrFirst;
    if (Option.isNone(window)) {
      return null;
    }

    const selectedItemId = yield* electronMenu.showContextMenu({
      window: window.value,
      items: input.items,
      position: Option.fromNullishOr(input.position),
    });
    return Option.getOrNull(selectedItemId);
  }),
});

export const openExternal = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.OPEN_EXTERNAL_CHANNEL,
  payload: Schema.String,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.window.openExternal")(function* (url) {
    const shell = yield* ElectronShell.ElectronShell;
    return yield* shell.openExternal(url);
  }),
});

export const openSystemSettings = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.OPEN_SYSTEM_SETTINGS_CHANNEL,
  payload: SystemSettingsPaneSchema,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.window.openSystemSettings")(function* (pane) {
    const shell = yield* ElectronShell.ElectronShell;
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    if (environment.platform !== "darwin") return false;
    const owner = Electron.BrowserWindow.getFocusedWindow();
    const opened = yield* shell.openSystemSettings(pane);
    if (opened && environment.isPackaged) {
      const permissions = yield* MacPermissions.MacPermissions;
      const isGranted = yield* safariPermissionCheck;
      yield* permissions.showHelper(pane, owner, isGranted);
    }
    return opened;
  }),
});

export const probeRemoteEditors = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PROBE_REMOTE_EDITORS_CHANNEL,
  payload: Schema.Undefined,
  result: Schema.Array(EditorId),
  handler: Effect.fn("desktop.ipc.window.probeRemoteEditors")(function* () {
    const available: Array<EditorId> = [];
    const env = yield* HostProcess.Environment;
    for (const editorId of REMOTE_CAPABLE_EDITOR_IDS) {
      const editor = EDITORS.find((editor) => editor.id === editorId);
      if (editor && Option.isSome(yield* resolveEditorCommand(editor, env))) {
        available.push(editorId);
      }
    }
    return available;
  }),
});

export const pasteAsText = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PASTE_AS_TEXT_CHANNEL,
  payload: Schema.Undefined,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.window.pasteAsText")(function* (_input, event) {
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const window = yield* electronWindow.main;
    if (
      event === undefined ||
      Option.isNone(window) ||
      window.value.isDestroyed() ||
      window.value.webContents.id !== event.sender.id
    ) {
      return;
    }
    const focused = Electron.webContents.getFocusedWebContents();
    if (
      focused &&
      !focused.isDestroyed() &&
      Electron.BrowserWindow.fromWebContents(focused) === window.value
    ) {
      focused.paste();
    }
  }),
});

export const revealWindow = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.REVEAL_WINDOW_CHANNEL,
  payload: Schema.Undefined,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.window.revealWindow")(function* (_input, event) {
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const window = yield* electronWindow.main;
    if (
      event === undefined ||
      Option.isNone(window) ||
      window.value.webContents.id !== event.sender.id
    ) {
      return;
    }
    yield* electronWindow.reveal(window.value);
  }),
});

const PICKED_THEME_FILE_MAX_BYTES = 256 * 1024;

export const pickThemeFiles = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PICK_THEME_FILES_CHANNEL,
  payload: Schema.Undefined,
  result: Schema.NullOr(Schema.Array(PickedThemeFileSchema)),
  handler: Effect.fn("desktop.ipc.window.pickThemeFiles")(function* () {
    const dialog = yield* ElectronDialog.ElectronDialog;
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const extensionsDir = path.join(yield* HostProcess.HomeDirectory, ".vscode", "extensions");
    const defaultPath = yield* fileSystem
      .exists(extensionsDir)
      .pipe(Effect.orElseSucceed(() => false));
    const paths = yield* dialog.pickFiles({
      owner: yield* electronWindow.focusedMainOrFirst,
      defaultPath: defaultPath ? Option.some(extensionsDir) : Option.none(),
      filters: [{ name: "JSON", extensions: ["json"] }],
      multiple: true,
    });
    if (paths.length === 0) {
      return null;
    }
    return yield* Effect.forEach(paths, (filePath) => {
      const name = path.basename(filePath);
      return Effect.gen(function* () {
        const info = yield* fileSystem.stat(filePath);
        const size = Number(info.size);
        if (size > PICKED_THEME_FILE_MAX_BYTES) {
          return { name, size, text: "" } satisfies PickedThemeFile;
        }
        const text = yield* fileSystem.readFileString(filePath);
        return { name, size, text } satisfies PickedThemeFile;
      }).pipe(Effect.orElseSucceed((): PickedThemeFile => ({ name, size: 0, text: "" })));
    });
  }),
});

export const checkSystemPermission = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.CHECK_SYSTEM_PERMISSION_CHANNEL,
  payload: SystemSettingsPaneSchema,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.window.checkSystemPermission")(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    if (environment.platform !== "darwin") return false;
    const check = yield* safariPermissionCheck;
    return yield* Effect.promise(check);
  }),
});
