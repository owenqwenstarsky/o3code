import { createFileRoute } from "@tanstack/react-router";

import { AdminWorkspacesPanel } from "../components/settings/AdminSettings";
import { requireInstanceAdmin } from "../instance/instanceState";

export const Route = createFileRoute("/_chat/settings/admin/workspaces")({
  beforeLoad: requireInstanceAdmin,
  component: AdminWorkspacesPanel,
});
