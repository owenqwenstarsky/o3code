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
    } finally {
      setBusy(false);
    }
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
  const [restarting, setRestarting] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const user = me.data?.user ?? null;
  const workspace = me.data?.workspace ?? null;
  const instance = session.data?._tag === "Some" ? session.data.value : null;

  const restartWorkspace = async () => {
    setRestarting(true);
    try {
      await instanceRequest((client, headers) => client.account.restartWorkspace({ headers }));
      toastManager.add({ type: "info", title: "Restarting your workspace" });
      me.refresh();
    } catch (cause) {
      toastManager.add({ type: "error", title: "Couldn't restart", description: errorText(cause) });
    } finally {
      setRestarting(false);
    }
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
    try {
      await runInstance(InstanceAccount.pipe(Effect.flatMap((account) => account.signOut)));
    } finally {
      setSigningOut(false);
      void navigate({ to: "/login", replace: true });
    }
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
          description="Forgets this device's sign-in. Your workspace keeps running."
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

      <SettingsSection title="Workspace">
        <SettingsRow
          title="Status"
          description={
            workspace?.tailnetHostname
              ? `Reachable on your tailnet at ${workspace.tailnetHostname}.`
              : (workspace?.statusMessage ?? "Your administrator manages your workspace.")
          }
          status={workspaceStatusBadge(workspace)}
          control={
            <Button
              disabled={restarting || workspace === null}
              size="sm"
              variant="outline"
              onClick={() => void restartWorkspace()}
            >
              {restarting ? "Restarting…" : "Restart"}
            </Button>
          }
        />
        {workspace ? (
          <SettingsRow
            title="Installed tools"
            description={workspace.tools.length > 0 ? workspace.tools.join(", ") : "None"}
          />
        ) : null}
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
