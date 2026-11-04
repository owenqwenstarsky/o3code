import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopConnectionCatalogStore from "../../app/DesktopConnectionCatalogStore.ts";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import { getDesktopUrl } from "../../electron/ElectronProtocol.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

class ConnectionCatalogIpcUnauthorizedSenderError extends Schema.TaggedError<ConnectionCatalogIpcUnauthorizedSenderError>()(
  "ConnectionCatalogIpcUnauthorizedSenderError",
  {},
) {
  override get message(): string {
    return "Connection catalog request was rejected.";
  }
}

const ensureTrustedSender = Effect.fn("desktop.ipc.connectionCatalog.ensureTrustedSender")(
  function* (event: DesktopIpc.DesktopIpcInvokeEvent | undefined) {
    const main = yield* (yield* ElectronWindow.ElectronWindow).main;
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    if (
      !event?.senderFrame ||
      Option.isNone(main) ||
      main.value.webContents.id !== event.sender.id ||
      main.value.webContents.mainFrame !== event.senderFrame ||
      !event.senderFrame.url.startsWith(getDesktopUrl(environment.isDevelopment))
    ) {
      return yield* new ConnectionCatalogIpcUnauthorizedSenderError();
    }
  },
);

export const getConnectionCatalog = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_CONNECTION_CATALOG_CHANNEL,
  payload: Schema.Void,
  result: Schema.NullOr(Schema.String),
  handler: Effect.fn("desktop.ipc.connectionCatalog.get")(function* (_input, event) {
    yield* ensureTrustedSender(event);
    const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
    return Option.getOrNull(yield* store.get);
  }),
});

export const setConnectionCatalog = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SET_CONNECTION_CATALOG_CHANNEL,
  payload: Schema.String,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.connectionCatalog.set")(function* (catalog, event) {
    yield* ensureTrustedSender(event);
    const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
    return yield* store.set(catalog);
  }),
});
