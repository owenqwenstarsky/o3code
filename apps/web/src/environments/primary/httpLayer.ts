import { layerRemoteHttpClient } from "@t3tools/client-runtime/rpc";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/http";

import { resolvePrimaryEnvironmentHttpUrl } from "./target";

function isSameOriginBrowserPrimary(): boolean {
  if (
    typeof window === "undefined" ||
    window.desktopBridge !== undefined ||
    !window.location.origin.startsWith("http")
  ) {
    return false;
  }

  return new URL(resolvePrimaryEnvironmentHttpUrl("/")).origin === window.location.origin;
}

export function layerForCurrentOrigin() {
  return Layer.unwrap(
    Effect.sync(() => {
      return Layer.merge(
        layerRemoteHttpClient(globalThis.fetch),
        Layer.succeed(FetchHttpClient.RequestInit, {
          credentials: isSameOriginBrowserPrimary() ? "include" : "omit",
        }),
      );
    }),
  );
}

export const layer = layerForCurrentOrigin();
