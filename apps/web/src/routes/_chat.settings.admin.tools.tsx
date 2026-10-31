import { createFileRoute } from "@tanstack/react-router";

import { AdminToolsPanel } from "../components/settings/AdminSettings";
import { requireInstanceAdmin } from "../instance/instanceState";

export const Route = createFileRoute("/_chat/settings/admin/tools")({
  beforeLoad: requireInstanceAdmin,
  component: AdminToolsPanel,
});
