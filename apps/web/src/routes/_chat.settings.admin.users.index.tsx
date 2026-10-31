import { createFileRoute } from "@tanstack/react-router";

import { AdminUsersPanel } from "../components/settings/AdminSettings";
import { requireInstanceAdmin } from "../instance/instanceState";

export const Route = createFileRoute("/_chat/settings/admin/users/")({
  beforeLoad: requireInstanceAdmin,
  component: AdminUsersPanel,
});
