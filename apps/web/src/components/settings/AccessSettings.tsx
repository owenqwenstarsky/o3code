import { SessionPermissions } from "./SessionPermissions";
import { ChevronRightIcon, EllipsisIcon } from "lucide-react";
import { useState } from "react";
import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  type AuthClientSession,
  type AuthPairingLink,
  type AuthPairingCredentialResult,
  resolveEnvironmentMachineKind,
} from "@t3tools/contracts";
import { environmentMcpUrl } from "@t3tools/client-runtime/connection";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";

import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { EnvironmentIconMenu } from "./EnvironmentIconPicker";
import { FoldedSettingsSection } from "./FoldedSettingsSection";
import { LinkedEnvironmentsSettings } from "./LinkedEnvironmentsSettings";
import { usePeerLinkHosts } from "~/state/peerLinks";
import { ScrollArea } from "../ui/scroll-area";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Button } from "../ui/button";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import {
  revokeOtherServerClientSessions,
  revokeServerClientSession,
  revokeServerPairingLink,
  type ServerClientSessionRecord,
} from "~/environments/primary";
import { authEnvironment } from "~/state/auth";
import {
  readEnvironmentScope,
  useEnvironmentScope,
  useEnvironmentSessionState,
  usePreparedConnection,
} from "~/state/session";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useEnvironmentQuery } from "~/state/query";
import { type EnvironmentPresentation, usePrimaryEnvironment } from "~/state/environments";
import {
  sortDesktopPairingLinks,
  summarizeAuthorizedClients,
  sortDesktopClientSessions,
  toDesktopPairingLinkRecord,
  toDesktopClientSessionRecord,
} from "./AccessSettings.logic";
import { AuthorizedClientsHeaderAction, PairingClientsList } from "./AuthorizedClientsSettings";
import { ITEM_ROW_CLASSNAME } from "./itemRows";

/** Who may reach the user's workspace: its permissions, authorized clients and linked environments. */
export function AccessSettings() {
  const primaryEnvironment = usePrimaryEnvironment();
  if (primaryEnvironment === null) {
    return (
      <SettingsPageContainer>
        <SettingsSection {...searchableSetting("connections-environment")}>
          <SettingsRow
            title="No workspace connected"
            description="Sign in to your O3 instance to view your workspace's access."
          />
        </SettingsSection>
      </SettingsPageContainer>
    );
  }
  return <WorkspaceAccessSettings primaryEnvironment={primaryEnvironment} />;
}

function WorkspaceAccessSettings({
  primaryEnvironment,
}: {
  readonly primaryEnvironment: EnvironmentPresentation;
}) {
  const peerLinkHosts = usePeerLinkHosts();
  const primaryEnvironmentId = primaryEnvironment.environmentId;
  const session = useEnvironmentSessionState(primaryEnvironmentId).data;
  const prepared = usePreparedConnection(primaryEnvironmentId);
  const mcpUrl = environmentMcpUrl({
    entry: primaryEnvironment.entry,
    connectedTarget:
      primaryEnvironment.connection.phase === "connected" && prepared._tag === "Some"
        ? prepared.value.target
        : null,
  });
  const { copyToClipboard: copyMcpUrl } = useCopyToClipboard<{ url: string }>({
    target: "MCP URL",
    onCopy: ({ url }) => {
      toastManager.add({
        type: "success",
        title: "MCP URL copied",
        description: `Add it to an agent, e.g. claude mcp add --transport http t3 ${url}`,
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not copy MCP URL",
          description: error.message,
        }),
      );
    },
  });
  const currentSessionScopes = session?.authenticated
    ? (session.permissions ?? session.scopes ?? null)
    : null;
  const [accessManagementMutationError, setAccessManagementMutationError] = useState<string | null>(
    null,
  );
  const [createdPairingCredentials, setCreatedPairingCredentials] = useState<
    ReadonlyMap<string, string>
  >(() => new Map());
  const handlePairingLinkCreated = (created: AuthPairingCredentialResult) => {
    setCreatedPairingCredentials((current) => new Map(current).set(created.id, created.credential));
  };
  const [revokingPairingLinkId, setRevokingPairingLinkId] = useState<string | null>(null);
  const [revokingClientSessionId, setRevokingClientSessionId] = useState<string | null>(null);
  const [isRevokingOtherClients, setIsRevokingOtherClients] = useState(false);
  const primaryServerConfig = primaryEnvironment.serverConfig;
  const canReadAccess = useEnvironmentScope(primaryEnvironmentId, AuthAccessReadScope);
  const canWriteAccess = useEnvironmentScope(primaryEnvironmentId, AuthAccessWriteScope);
  const authAccessChanges = useEnvironmentQuery(
    canReadAccess
      ? authEnvironment.accessChanges({
          environmentId: primaryEnvironmentId,
          input: null,
        })
      : null,
  );
  const accessManagementError = accessManagementMutationError ?? authAccessChanges.error;
  const isLoadingAccessManagement = authAccessChanges.isPending && authAccessChanges.data === null;
  const pairingLinks = (() => {
    const event = authAccessChanges.data;
    if (event?.type !== "snapshot") return [];
    return sortDesktopPairingLinks(
      event.payload.pairingLinks.map((pairingLink: AuthPairingLink) =>
        toDesktopPairingLinkRecord(pairingLink),
      ),
    );
  })();
  const clientSessions = (() => {
    const event = authAccessChanges.data;
    if (event?.type !== "snapshot") return [];
    return sortDesktopClientSessions(
      event.payload.clientSessions.map((clientSession: AuthClientSession) =>
        toDesktopClientSessionRecord(clientSession),
      ),
    );
  })();

  const reportFailure = (title: string, fallback: string, cause: Cause.Cause<unknown>) => {
    const error = Cause.squash(cause);
    const message = error instanceof Error ? error.message : fallback;
    setAccessManagementMutationError(message);
    toastManager.add(stackedThreadToast({ type: "error", title, description: message }));
  };

  const canRevokeAccess = () => readEnvironmentScope(primaryEnvironmentId, AuthAccessWriteScope);

  const handleRevokePairingLink = async (id: string) => {
    if (!canRevokeAccess()) return;
    setRevokingPairingLinkId(id);
    setAccessManagementMutationError(null);
    const settled = await settlePromise(() => revokeServerPairingLink(id));
    if (settled._tag === "Failure") {
      reportFailure(
        "Could not revoke pairing link",
        "Failed to revoke pairing link.",
        settled.cause,
      );
    }
    setRevokingPairingLinkId(null);
  };

  const handleRevokeClientSession = async (sessionId: ServerClientSessionRecord["sessionId"]) => {
    if (!canRevokeAccess()) return;
    setRevokingClientSessionId(sessionId);
    setAccessManagementMutationError(null);
    const settled = await settlePromise(() => revokeServerClientSession(sessionId));
    if (settled._tag === "Failure") {
      reportFailure(
        "Could not revoke client access",
        "Failed to revoke client access.",
        settled.cause,
      );
    }
    setRevokingClientSessionId(null);
  };

  const handleRevokeOtherClients = async () => {
    if (!canRevokeAccess()) return;
    setIsRevokingOtherClients(true);
    setAccessManagementMutationError(null);
    const settled = await settlePromise(async () => {
      const revokedCount = await revokeOtherServerClientSessions();
      toastManager.add({
        type: "success",
        title: revokedCount === 1 ? "Revoked 1 other client" : `Revoked ${revokedCount} clients`,
        description: "Other paired clients will need a new pairing code before reconnecting.",
      });
    });
    if (settled._tag === "Failure") {
      reportFailure(
        "Could not revoke other clients",
        "Failed to revoke other clients.",
        settled.cause,
      );
    }
    setIsRevokingOtherClients(false);
  };

  return (
    <SettingsPageContainer>
      <SettingsSection
        {...searchableSetting("connections-environment")}
        title={primaryEnvironment.label}
        icon={
          <EnvironmentMachineIcon
            aria-hidden
            kind={
              primaryServerConfig ? resolveEnvironmentMachineKind(primaryServerConfig) : "server"
            }
            className="size-4"
          />
        }
        headerAction={
          <Menu>
            <MenuTrigger
              render={
                <Button
                  type="button"
                  variant="ghost-muted"
                  size="icon-xs"
                  aria-label="More actions for this workspace"
                />
              }
            >
              <EllipsisIcon className="size-3.5" />
            </MenuTrigger>
            <MenuPopup align="end">
              <EnvironmentIconMenu
                environmentId={primaryEnvironment.environmentId}
                serverConfig={primaryServerConfig}
              />
              {mcpUrl ? (
                <MenuItem onClick={() => copyMcpUrl(mcpUrl, { url: mcpUrl })}>
                  Copy MCP URL
                </MenuItem>
              ) : null}
            </MenuPopup>
          </Menu>
        }
      >
        <details className="group px-3 sm:px-4">
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-md text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
            Permissions
            <ChevronRightIcon
              aria-hidden
              className="size-3 text-muted-foreground group-open:rotate-90"
            />
          </summary>
          <SessionPermissions
            environmentId={primaryEnvironment.environmentId}
            connected={primaryEnvironment.connection.phase === "connected"}
          />
        </details>
      </SettingsSection>

      {canReadAccess || canWriteAccess ? (
        <FoldedSettingsSection
          id="authorized-clients"
          title="Authorized clients"
          summary={summarizeAuthorizedClients(clientSessions, pairingLinks)}
          control={
            canWriteAccess ? (
              <AuthorizedClientsHeaderAction
                delegatableScopes={currentSessionScopes ?? []}
                onPairingLinkCreated={handlePairingLinkCreated}
                clientSessions={
                  canReadAccess &&
                  authAccessChanges.error === null &&
                  authAccessChanges.data?.type === "snapshot"
                    ? clientSessions
                    : null
                }
                isRevokingOtherClients={isRevokingOtherClients}
                onRevokeOtherClients={handleRevokeOtherClients}
              />
            ) : undefined
          }
        >
          <ScrollArea
            scrollFade
            chainVerticalScroll
            className="max-h-[22.5rem]"
            data-testid="authorized-clients-scroll-area"
          >
            {canReadAccess ? (
              <>
                {accessManagementError ? (
                  <div className={ITEM_ROW_CLASSNAME}>
                    <p className="text-xs text-destructive">{accessManagementError}</p>
                  </div>
                ) : null}
                <PairingClientsList
                  isLoading={isLoadingAccessManagement}
                  pairingLinks={pairingLinks}
                  createdPairingCredentials={createdPairingCredentials}
                  clientSessions={clientSessions}
                  revokingPairingLinkId={revokingPairingLinkId}
                  revokingClientSessionId={revokingClientSessionId}
                  onRevokePairingLink={handleRevokePairingLink}
                  onRevokeClientSession={handleRevokeClientSession}
                  canRevoke={canWriteAccess}
                />
              </>
            ) : (
              <p className="px-4 py-3 text-xs text-muted-foreground">
                This connection can create access links but cannot view authorized clients.
              </p>
            )}
          </ScrollArea>
        </FoldedSettingsSection>
      ) : null}

      {peerLinkHosts.map((environment, index) => (
        <LinkedEnvironmentsSettings
          key={environment.environmentId}
          environmentId={environment.environmentId}
          environmentLabel={peerLinkHosts.length > 1 ? environment.label : null}
          isSearchTarget={index === 0}
        />
      ))}
    </SettingsPageContainer>
  );
}
