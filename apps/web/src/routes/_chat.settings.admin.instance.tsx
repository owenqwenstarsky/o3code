import { createFileRoute } from "@tanstack/react-router";

import { AdminInstancePanel } from "../components/settings/AdminSettings";
import { requireInstanceAdmin } from "../instance/instanceState";

export const Route = createFileRoute("/_chat/settings/admin/instance")({
  beforeLoad: requireInstanceAdmin,
  component: AdminInstancePanel,
});
