import { createFileRoute } from "@tanstack/react-router";

import { AdminOverviewPanel } from "../components/settings/AdminSettings";
import { requireInstanceAdmin } from "../instance/instanceState";

export const Route = createFileRoute("/_chat/settings/admin/overview")({
  beforeLoad: requireInstanceAdmin,
  component: AdminOverviewPanel,
});
