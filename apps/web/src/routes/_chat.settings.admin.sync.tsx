import { createFileRoute } from "@tanstack/react-router";

import { AdminAuthSyncPanel } from "../components/settings/AdminAuthSyncSettings";
import { requireInstanceAdmin } from "../instance/instanceState";

export const Route = createFileRoute("/_chat/settings/admin/sync")({
  beforeLoad: requireInstanceAdmin,
  component: AdminAuthSyncPanel,
});
