import { InstanceUserId } from "@t3tools/contracts/instance";
import { createFileRoute } from "@tanstack/react-router";

import { AdminUserDetailPanel } from "../components/settings/AdminSettings";
import { requireInstanceAdmin } from "../instance/instanceState";

export const Route = createFileRoute("/_chat/settings/admin/users/$userId")({
  beforeLoad: requireInstanceAdmin,
  component: AdminUserDetailRoute,
});

function AdminUserDetailRoute() {
  const { userId } = Route.useParams();
  return <AdminUserDetailPanel key={userId} userId={InstanceUserId.make(userId)} />;
}
