import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/projects/$projectKey")({
  beforeLoad: async ({ context, params }) => {
    if (context.authGateState.status !== "hosted-static") {
      throw redirect({ to: "/login", replace: true });
    }
    throw redirect({
      to: "/settings/projects",
      search: { project: params.projectKey, machine: undefined },
      replace: true,
    });
  },
});
