import { createFileRoute } from "@tanstack/react-router";

import { AdminAuditPanel } from "../components/settings/AdminSettings";
import { requireInstanceAdmin } from "../instance/instanceState";

export const Route = createFileRoute("/_chat/settings/admin/audit")({
  beforeLoad: requireInstanceAdmin,
  component: AdminAuditPanel,
});
