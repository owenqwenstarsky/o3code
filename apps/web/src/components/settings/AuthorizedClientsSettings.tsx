import { AUTH_SCOPE_OPTIONS as PAIRING_SCOPE_OPTIONS } from "@t3tools/shared/authScopeOptions";
import { PlusIcon } from "lucide-react";
import { memo, useState } from "react";
import {
  AuthAccessWriteScope,
  AuthDiagnosticsReadScope,
  AuthOrchestrationReadScope,
  AuthFilesystemReadScope,
  AuthStandardClientScopes,
  AuthTerminalReadScope,
  type AuthEnvironmentScope,
  type AuthGrantScope,
  type AuthPairingCredentialResult,
} from "@t3tools/contracts";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { formatElapsedDurationLabel, formatExpiresInLabel } from "../../timestampFormat";
import {
  canRevokeOtherClients,
  formatAccessTimestamp,
  togglePairingScopeSelection,
} from "./AccessSettings.logic";
import { useNowSecond } from "../../hooks/useNowSecond";
import { Input } from "../ui/input";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogFooter,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import {
  createServerPairingCredential,
  type ServerClientSessionRecord,
  type ServerPairingLinkRecord,
} from "~/environments/primary";
import { readEnvironmentScope } from "~/state/session";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { ConnectionStatusDot } from "../ConnectionStatusDot";
import { ITEM_ROW_CLASSNAME, ITEM_ROW_INNER_CLASSNAME } from "./itemRows";

function AccessScopeSummary({
  scopes,
  label,
}: {
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly label: string;
}) {
  const scopeCountLabel = `${scopes.length} ${scopes.length === 1 ? "scope" : "scopes"}`;

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={250}
        closeDelay={100}
        render={
          <button
            type="button"
            aria-label={`${label}: show ${scopeCountLabel}`}
            className="cursor-help underline decoration-border underline-offset-2 outline-hidden hover:text-foreground focus-visible:text-foreground"
          />
        }
      >
        {scopeCountLabel}
      </PopoverTrigger>
      <PopoverPopup
        side="top"
        align="start"
        tooltipStyle
        className="w-max max-w-80 whitespace-normal"
      >
        <p className="mb-1 font-medium">Granted scopes</p>
        <div className="flex flex-col gap-0.5">
          {scopes.map((scope) => (
            <code key={scope} className="font-mono text-foreground/85">
              {scope}
            </code>
          ))}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

type PairingLinkListRowProps = {
  pairingLink: ServerPairingLinkRecord;
  credential: string | undefined;
  revokingPairingLinkId: string | null;
  onRevoke: (id: string) => void;
  canRevoke: boolean;
};

const PairingLinkListRow = memo(function PairingLinkListRow({
  pairingLink,
  credential,
  revokingPairingLinkId,
  onRevoke,
  canRevoke,
}: PairingLinkListRowProps) {
  const nowMs = useNowSecond();
  const expiresAtMs = new Date(pairingLink.expiresAt).getTime();
  const [isRevealDialogOpen, setIsRevealDialogOpen] = useState(false);
  const canCopyToClipboard =
    typeof window !== "undefined" &&
    window.isSecureContext &&
    navigator.clipboard?.writeText != null;

  const { copyToClipboard } = useCopyToClipboard({
    onCopy: () => {
      toastManager.add({
        type: "success",
        title: "Pairing code copied",
        description: "Paste it into the client you want to pair.",
      });
    },
    onError: (error) => {
      setIsRevealDialogOpen(true);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: canCopyToClipboard ? "Could not copy pairing code" : "Clipboard copy unavailable",
          description: canCopyToClipboard ? error.message : "Showing the full value instead.",
        }),
      );
    },
  });

  const handleCopyCode = () => {
    if (credential) copyToClipboard(credential, undefined);
  };

  if (expiresAtMs <= nowMs) {
    return null;
  }

  return (
    <div className={ITEM_ROW_CLASSNAME}>
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-h-5 items-center gap-1.5">
            <ConnectionStatusDot
              tooltipText={`Link created at ${formatAccessTimestamp(pairingLink.createdAt)}`}
              dotClassName="bg-warning"
            />
            <h3 className="text-sm font-medium text-foreground">
              {pairingLink.label ?? "Pairing link"}
            </h3>
          </div>
          <p className="text-xs text-muted-foreground">
            <Tooltip>
              <TooltipTrigger render={<span />}>
                {formatExpiresInLabel(pairingLink.expiresAt, nowMs)}
              </TooltipTrigger>
              <TooltipPopup side="top">{formatAccessTimestamp(pairingLink.expiresAt)}</TooltipPopup>
            </Tooltip>
            <span aria-hidden> · </span>
            <AccessScopeSummary scopes={pairingLink.scopes} label="Pairing link scopes" />
          </p>
          {!credential ? (
            <p className="text-2xs text-muted-foreground/70">
              Create a new link to share from this client.
            </p>
          ) : null}
        </div>
        <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
          <Dialog
            open={credential !== undefined && isRevealDialogOpen}
            onOpenChange={setIsRevealDialogOpen}
          >
            {!credential ? null : canCopyToClipboard ? (
              <Button size="xs" variant="outline" onClick={handleCopyCode}>
                Copy code
              </Button>
            ) : (
              <DialogTrigger render={<Button size="xs" variant="outline" />}>
                Show code
              </DialogTrigger>
            )}
            <DialogPopup className="max-w-md">
              <DialogHeader>
                <DialogTitle>Pairing code</DialogTitle>
                <DialogDescription>
                  Clipboard copy is unavailable here. Manually copy this code into another client.
                </DialogDescription>
              </DialogHeader>
              <DialogPanel>
                <Textarea
                  readOnly
                  value={credential ?? ""}
                  rows={3}
                  onFocus={(event) => event.currentTarget.select()}
                  onClick={(event) => event.currentTarget.select()}
                />
              </DialogPanel>
              <DialogFooter variant="bare">
                <Button variant="outline" onClick={() => setIsRevealDialogOpen(false)}>
                  Done
                </Button>
              </DialogFooter>
            </DialogPopup>
          </Dialog>
          <Button
            size="xs"
            variant="destructive-outline"
            disabled={!canRevoke || revokingPairingLinkId === pairingLink.id}
            onClick={() => void onRevoke(pairingLink.id)}
          >
            {revokingPairingLinkId === pairingLink.id ? "Revoking…" : "Revoke"}
          </Button>
        </div>
      </div>
    </div>
  );
});

type ConnectedClientListRowProps = {
  clientSession: ServerClientSessionRecord;
  revokingClientSessionId: string | null;
  onRevokeSession: (sessionId: ServerClientSessionRecord["sessionId"]) => void;
  canRevoke: boolean;
};

const ConnectedClientListRow = memo(function ConnectedClientListRow({
  clientSession,
  revokingClientSessionId,
  onRevokeSession,
  canRevoke,
}: ConnectedClientListRowProps) {
  const nowMs = useNowSecond();
  const isLive = clientSession.current || clientSession.connected;
  const lastConnectedAt = clientSession.lastConnectedAt;
  const statusTooltip = isLive
    ? lastConnectedAt
      ? `Connected for ${formatElapsedDurationLabel(lastConnectedAt, nowMs)}`
      : "Connected"
    : lastConnectedAt
      ? `Last connected at ${formatAccessTimestamp(lastConnectedAt)}`
      : "Not connected yet.";
  const deviceInfoBits = [
    clientSession.client.deviceType !== "unknown"
      ? clientSession.client.deviceType[0]?.toUpperCase() + clientSession.client.deviceType.slice(1)
      : null,
    clientSession.client.os ?? null,
    clientSession.client.browser ?? null,
    clientSession.client.ipAddress ?? null,
  ].filter((value): value is string => value !== null);
  const primaryLabel =
    clientSession.client.label ??
    ([clientSession.client.os, clientSession.client.browser].filter(Boolean).join(" · ") ||
      clientSession.subject);

  return (
    <div className={ITEM_ROW_CLASSNAME}>
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-h-5 items-center gap-1.5">
            <ConnectionStatusDot
              tooltipText={statusTooltip}
              dotClassName={isLive ? "bg-success" : "bg-muted-foreground/30"}
              pingClassName={isLive ? "bg-success/60 duration-2000" : null}
            />
            <h3 className="text-sm font-medium text-foreground">{primaryLabel}</h3>
            {clientSession.current ? (
              <span className="text-3xs text-muted-foreground/80 rounded-md border border-border/50 bg-muted/50 px-1 py-0.5">
                This device
              </span>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            {deviceInfoBits.length > 0 ? (
              <>
                {deviceInfoBits.join(" · ")}
                <span aria-hidden> · </span>
              </>
            ) : null}
            <AccessScopeSummary scopes={clientSession.scopes} label="Client scopes" />
          </p>
        </div>
        <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
          {!clientSession.current ? (
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={!canRevoke || revokingClientSessionId === clientSession.sessionId}
              onClick={() => void onRevokeSession(clientSession.sessionId)}
            >
              {revokingClientSessionId === clientSession.sessionId ? "Revoking…" : "Revoke"}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
});

type AuthorizedClientsHeaderActionProps = {
  onPairingLinkCreated: (result: AuthPairingCredentialResult) => void;
  clientSessions: ReadonlyArray<ServerClientSessionRecord> | null;
  isRevokingOtherClients: boolean;
  onRevokeOtherClients: () => void;
  delegatableScopes: ReadonlyArray<AuthEnvironmentScope>;
};

export const AuthorizedClientsHeaderAction = memo(function AuthorizedClientsHeaderAction({
  onPairingLinkCreated,
  clientSessions,
  isRevokingOtherClients,
  onRevokeOtherClients,
  delegatableScopes,
}: AuthorizedClientsHeaderActionProps) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [pairingLabel, setPairingLabel] = useState("");
  const [pairingScopes, setPairingScopes] = useState<ReadonlyArray<AuthGrantScope>>([
    ...AuthStandardClientScopes,
  ]);
  const selectedScopes = pairingScopes.filter((scope) => delegatableScopes.includes(scope));
  const [isCreatingPairingLink, setIsCreatingPairingLink] = useState(false);

  const handleCreatePairingLink = async () => {
    if (
      primaryEnvironmentId === null ||
      selectedScopes.length === 0 ||
      !readEnvironmentScope(primaryEnvironmentId, AuthAccessWriteScope) ||
      !selectedScopes.every((scope) => readEnvironmentScope(primaryEnvironmentId, scope))
    )
      return;
    setIsCreatingPairingLink(true);
    const settled = await settlePromise(async () => {
      const created = await createServerPairingCredential({
        label: pairingLabel,
        scopes: selectedScopes,
      });
      onPairingLinkCreated(created);
      setPairingLabel("");
      setPairingScopes(
        AuthStandardClientScopes.filter((scope) => delegatableScopes.includes(scope)),
      );
      setDialogOpen(false);
    });
    if (settled._tag === "Failure") {
      const error = Cause.squash(settled.cause);
      const message = error instanceof Error ? error.message : "Failed to create pairing URL.";
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not create pairing URL",
          description: message,
        }),
      );
    }
    setIsCreatingPairingLink(false);
  };

  const togglePairingScope = (scope: AuthGrantScope, checked: boolean) => {
    setPairingScopes((current) => togglePairingScopeSelection(current, scope, checked));
  };

  return (
    <div className="flex items-center gap-2">
      <Button
        size="xs"
        variant="destructive-outline"
        disabled={isRevokingOtherClients || !canRevokeOtherClients(clientSessions)}
        onClick={() => void onRevokeOtherClients()}
      >
        {isRevokingOtherClients ? "Revoking…" : "Revoke others"}
      </Button>
      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) {
            setPairingLabel("");
            setPairingScopes(
              AuthStandardClientScopes.filter((scope) => delegatableScopes.includes(scope)),
            );
          }
        }}
      >
        <DialogTrigger
          render={
            <Button size="xs" variant="default">
              <PlusIcon className="size-3" />
              Create link
            </Button>
          }
        />
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <DialogTitle>Create pairing link</DialogTitle>
            <DialogDescription>
              Generate a one-time pairing code that another client, such as an outside agent, can
              use to pair with this workspace.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-foreground">
                Client label (optional)
              </span>
              <Input
                value={pairingLabel}
                onChange={(event) => setPairingLabel(event.target.value)}
                placeholder="e.g. Living room iPad"
                disabled={isCreatingPairingLink}
                autoFocus
              />
            </label>
            <section className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-xs font-medium text-foreground">Permissions</h3>
                  <p className="text-xs text-muted-foreground">
                    Limit what the paired client can do.
                  </p>
                </div>
                <div className="flex gap-1">
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={isCreatingPairingLink}
                    onClick={() =>
                      setPairingScopes(
                        [
                          AuthOrchestrationReadScope,
                          AuthFilesystemReadScope,
                          AuthDiagnosticsReadScope,
                          AuthTerminalReadScope,
                        ].filter((scope) => delegatableScopes.includes(scope)),
                      )
                    }
                  >
                    Read only
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={isCreatingPairingLink}
                    onClick={() =>
                      setPairingScopes(
                        AuthStandardClientScopes.filter((scope) =>
                          delegatableScopes.includes(scope),
                        ),
                      )
                    }
                  >
                    Standard
                  </Button>
                </div>
              </div>
              <div className="divide-y divide-border/60 rounded-lg border border-input bg-muted/25">
                {PAIRING_SCOPE_OPTIONS.filter(({ scope }) => delegatableScopes.includes(scope)).map(
                  ({ scope, title, description }) => (
                    <label
                      key={scope}
                      className="flex cursor-pointer items-start gap-3 px-3 py-2.5 transition-colors hover:bg-muted/40"
                    >
                      <Checkbox
                        className="mt-0.5"
                        checked={pairingScopes.includes(scope)}
                        disabled={isCreatingPairingLink}
                        onCheckedChange={(checked) => togglePairingScope(scope, checked === true)}
                      />
                      <span className="min-w-0">
                        <span className="block text-xs font-medium text-foreground">{title}</span>
                        <span className="block text-xs leading-snug text-muted-foreground">
                          {description}
                        </span>
                      </span>
                    </label>
                  ),
                )}
              </div>
              {selectedScopes.length === 0 ? (
                <p className="text-xs text-destructive">Select at least one permission.</p>
              ) : selectedScopes.includes(AuthAccessWriteScope) ? (
                <p className="text-xs text-warning">
                  This client can create or revoke access for other devices.
                </p>
              ) : null}
            </section>
          </DialogPanel>
          <DialogFooter variant="bare">
            <Button
              variant="outline"
              disabled={isCreatingPairingLink}
              onClick={() => setDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              disabled={isCreatingPairingLink || selectedScopes.length === 0}
              onClick={() => void handleCreatePairingLink()}
            >
              {isCreatingPairingLink ? "Creating…" : "Create link"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
});

type PairingClientsListProps = {
  isLoading: boolean;
  pairingLinks: ReadonlyArray<ServerPairingLinkRecord>;
  createdPairingCredentials: ReadonlyMap<string, string>;
  clientSessions: ReadonlyArray<ServerClientSessionRecord>;
  revokingPairingLinkId: string | null;
  revokingClientSessionId: string | null;
  onRevokePairingLink: (id: string) => void;
  onRevokeClientSession: (sessionId: ServerClientSessionRecord["sessionId"]) => void;
  canRevoke: boolean;
};

export const PairingClientsList = memo(function PairingClientsList({
  isLoading,
  pairingLinks,
  createdPairingCredentials,
  clientSessions,
  revokingPairingLinkId,
  revokingClientSessionId,
  onRevokePairingLink,
  onRevokeClientSession,
  canRevoke,
}: PairingClientsListProps) {
  return (
    <>
      {pairingLinks.map((pairingLink) => (
        <PairingLinkListRow
          key={pairingLink.id}
          pairingLink={pairingLink}
          credential={createdPairingCredentials.get(pairingLink.id)}
          revokingPairingLinkId={revokingPairingLinkId}
          onRevoke={onRevokePairingLink}
          canRevoke={canRevoke}
        />
      ))}

      {clientSessions.map((clientSession) => (
        <ConnectedClientListRow
          key={clientSession.sessionId}
          clientSession={clientSession}
          revokingClientSessionId={revokingClientSessionId}
          onRevokeSession={onRevokeClientSession}
          canRevoke={canRevoke}
        />
      ))}

      {pairingLinks.length === 0 && clientSessions.length === 0 && !isLoading ? (
        <div className={ITEM_ROW_CLASSNAME}>
          <p className="text-xs text-muted-foreground/60">No pairing links or client sessions.</p>
        </div>
      ) : null}
    </>
  );
});
