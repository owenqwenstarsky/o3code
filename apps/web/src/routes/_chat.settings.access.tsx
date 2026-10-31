import { createFileRoute } from "@tanstack/react-router";
import { AccessSettings } from "../components/settings/AccessSettings";

export const Route = createFileRoute("/_chat/settings/access")({
  component: AccessSettings,
});
