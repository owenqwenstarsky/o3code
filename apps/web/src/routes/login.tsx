import { createFileRoute } from "@tanstack/react-router";

import { InstanceLoginSurface } from "../components/auth/InstanceLoginSurface";

export const Route = createFileRoute("/login")({
  component: LoginRouteView,
});

function LoginRouteView() {
  return (
    <InstanceLoginSurface
      onSignedIn={() => {
        // Rebuild the connection runtime so it starts with the newly saved workspace.
        window.location.replace(window.location.origin + (window.desktopBridge ? "/#/" : "/"));
      }}
    />
  );
}
