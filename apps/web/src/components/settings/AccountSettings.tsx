import { InstanceAccount } from "@t3tools/client-runtime/instance";
import type { InstanceWorkspace } from "@t3tools/contracts/instance";
import { useNavigate } from "@tanstack/react-router";
import * as Effect from "effect/Effect";
import { useState } from "react";

import {
  instanceMeAtom,
  instanceRequest,
  instanceSessionAtom,
  mySessionsAtom,
  runInstance,
} from "../../instance/instanceState";
import { useEnvironmentQuery } from "../../state/query";
import { Alert, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

export function workspaceStatusBadge(workspace: InstanceWorkspace | null) {
  if (workspace === null) return <Badge variant="outline">No workspace</Badge>;
  switch (workspace.status) {
    case "running":
      return <Badge variant="success">Running</Badge>;
    case "error":
      return <Badge variant="error">Needs attention</Badge>;
    case "stopped":
      return <Badge variant="outline">Stopped</Badge>;
    default:
      return <Badge variant="info">{workspace.statusMessage ?? "Starting"}</Badge>;
  }
}

/** One badge for all of a user's workspaces. */
export function workspaceSummaryBadge(workspaces: ReadonlyArray<InstanceWorkspace>) {
  if (workspaces.length <= 1) return workspaceStatusBadge(workspaces[0] ?? null);
  const running = workspaces.filter((workspace) => workspace.status === "running").length;
  const failing = workspaces.some((workspace) => workspace.status === "error");
  return (
    <Badge variant={failing ? "warning" : running === workspaces.length ? "success" : "outline"}>
      {running} of {workspaces.length} running
    </Badge>
  );
}

function workspaceDescription(workspace: InstanceWorkspace) {
  return workspace.tailnetHostname
    ? `Reachable on your tailnet at ${workspace.tailnetHostname}.`
    : (workspace.statusMessage ?? "Your administrator manages your workspace.");
}

export function describeDevice(session: {
  readonly label: string | null;
  readonly browser: string | null;
  readonly os: string | null;
}) {
  return (
    session.label ??
    ([session.browser, session.os].filter(Boolean).join(" on ") || "Unknown device")
  );
}

function errorText(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}

function ChangePasswordRow() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const submit = async (event: React.SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (next !== confirm) {
      setError("The new passwords don't match.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await instanceRequest((client, headers) =>
        client.account.changePassword({
          headers,
          payload: { currentPassword: current, newPassword: next },
        }),
      );
      setOpen(false);
      setCurrent("");
      setNext("");
      setConfirm("");
      toastManager.add({
        type: "success",
        title: "Password changed",
        description: "Your other devices were signed out.",
      });
    } catch (cause) {
      setError(errorText(cause));
    }
    setBusy(false);
  };

  return (
    <SettingsRow
      title="Password"
      description="Changing it signs out your other devices."
      control={
        open ? null : (
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            Change password
          </Button>
        )
      }
    >
      {open ? (
        <form className="mt-3 grid max-w-md gap-2" onSubmit={(event) => void submit(event)}>
          <Input
            aria-label="Current password"
            autoComplete="current-password"
            nativeInput
            onChange={(event) => setCurrent(event.currentTarget.value)}
            placeholder="Current password"
            type="password"
            value={current}
          />
          <Input
            aria-label="New password"
            autoComplete="new-password"
            nativeInput
            onChange={(event) => setNext(event.currentTarget.value)}
            placeholder="New password (at least 10 characters)"
            type="password"
            value={next}
          />
          <Input
            aria-label="Confirm new password"
            autoComplete="new-password"
            nativeInput
            onChange={(event) => setConfirm(event.currentTarget.value)}
            placeholder="Confirm new password"
            type="password"
            value={confirm}
          />
          {error ? (
            <Alert variant="error">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <div className="flex gap-2">
            <Button disabled={busy || next.length < 10 || current === ""} size="sm" type="submit">
              {busy ? "Saving…" : "Save password"}
            </Button>
            <Button disabled={busy} size="sm" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
    </SettingsRow>
  );
}

export function AccountSettingsPanel() {
  const navigate = useNavigate();
  const me = useEnvironmentQuery(instanceMeAtom);
  const session = useEnvironmentQuery(instanceSessionAtom);
  const devices = useEnvironmentQuery(mySessionsAtom);
  const [restarting, setRestarting] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  const user = me.data?.user ?? null;
  const workspaces = me.data?.workspaces ?? [];
  const instance = session.data?._tag === "Some" ? session.data.value : null;

  const restartWorkspace = async (workspace: InstanceWorkspace) => {
    setRestarting(workspace.id);
    try {
      await instanceRequest((client, headers) =>
        client.account.restartMyWorkspace({ headers, params: { workspaceId: workspace.id } }),
      );
      toastManager.add({ type: "info", title: `Restarting ${workspace.label}` });
      me.refresh();
    } catch (cause) {
      toastManager.add({ type: "error", title: "Couldn't restart", description: errorText(cause) });
    }
    setRestarting(null);
  };

  const revoke = async (sessionId: string) => {
    try {
      await instanceRequest((client, headers) =>
        client.account.revokeSession({ headers, params: { sessionId } }),
      );
      devices.refresh();
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: "Couldn't sign out",
        description: errorText(cause),
      });
    }
  };

  const signOut = async () => {
    setSigningOut(true);
    // Signing out locally must finish even if the instance can't be reached.
    await runInstance(InstanceAccount.pipe(Effect.flatMap((account) => account.signOut))).catch(
      () => undefined,
    );
    setSigningOut(false);
    void navigate({ to: "/login", replace: true });
  };

  return (
    <SettingsPageContainer>
      {me.error ? (
        <Alert variant="error">
          <AlertDescription>{me.error}</AlertDescription>
        </Alert>
      ) : null}
      <SettingsSection title="Account">
        <SettingsRow
          title={user?.name ?? "…"}
          description={user ? `${user.email} · ${instance?.name ?? "O3 instance"}` : undefined}
          status={user?.role === "admin" ? <Badge variant="secondary">Admin</Badge> : null}
        />
        <ChangePasswordRow />
        <SettingsRow
          title="Sign out"
          description="Forgets this device's sign-in. Your workspaces keep running."
          control={
            <Button
              disabled={signingOut}
              size="sm"
              variant="outline"
              onClick={() => void signOut()}
            >
              {signingOut ? "Signing out…" : "Sign out"}
            </Button>
          }
        />
      </SettingsSection>

      <SettingsSection title={workspaces.length > 1 ? "Workspaces" : "Workspace"}>
        {workspaces.length === 0 && me.data ? (
          <SettingsRow
            title="No workspace"
            description="Your administrator manages your workspaces."
            status={workspaceStatusBadge(null)}
          />
        ) : null}
        {workspaces.map((workspace) => (
          <SettingsRow
            key={workspace.id}
            title={workspaces.length > 1 ? workspace.label : "Status"}
            description={`${workspaceDescription(workspace)} Tools: ${
              workspace.tools.length > 0 ? workspace.tools.join(", ") : "none"
            }.`}
            status={
              <span className="flex items-center gap-1.5">
                {workspaces.length > 1 && workspace.isDefault ? (
                  <Badge variant="secondary">Default</Badge>
                ) : null}
                {workspaceStatusBadge(workspace)}
              </span>
            }
            control={
              <Button
                disabled={restarting !== null}
                size="sm"
                variant="outline"
                onClick={() => void restartWorkspace(workspace)}
              >
                {restarting === workspace.id ? "Restarting…" : "Restart"}
              </Button>
            }
          />
        ))}
      </SettingsSection>

      <SettingsSection title="Signed-in devices">
        {(devices.data?.sessions ?? []).map((device) => (
          <SettingsRow
            key={device.id}
            title={describeDevice(device)}
            description={`Signed in ${new Date(device.issuedAt).toLocaleString()}${device.ipAddress ? ` from ${device.ipAddress}` : ""}`}
            status={device.current ? <Badge variant="secondary">This device</Badge> : null}
            control={
              device.current ? null : (
                <Button size="sm" variant="outline" onClick={() => void revoke(device.id)}>
                  Sign out
                </Button>
              )
            }
          />
        ))}
        {devices.error ? (
          <SettingsRow title="Couldn't load devices" description={devices.error} />
        ) : null}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
