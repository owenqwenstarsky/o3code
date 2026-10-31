import { Link } from "@tanstack/react-router";

import { APP_DISPLAY_NAME } from "~/branding";
import { isElectron } from "../env";
import { Button } from "./ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty";
import { SidebarInset } from "./ui/sidebar";
import { WorkspacePageHeader } from "./WorkspacePageHeader";

/** Home screen while the signed-in user's workspace is not registered yet. */
export function HostedEmptyState() {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-foreground md:text-muted-foreground/60">
              {APP_DISPLAY_NAME}
            </span>
          </div>
        </WorkspacePageHeader>

        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyTitle>Your workspace is not connected</EmptyTitle>
            <EmptyDescription>
              Your agents run in your workspace. Check its status, or restart it, from your account.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button render={<Link to="/settings/account" />} size="sm">
              Open Account
            </Button>
          </EmptyContent>
        </Empty>
      </div>
    </SidebarInset>
  );
}
