import type {
  InstanceSettings,
  InstanceTool,
  InstanceUserId,
  InstanceUserRole,
  InstanceWorkspace,
  InstanceWorkspaceAction,
  InstanceWorkspaceLimits,
} from "@t3tools/contracts/instance";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import {
  adminAuditAtom,
  adminOverviewAtom,
  adminSettingsAtom,
  adminToolsAtom,
  adminUserAtom,
  adminUserSessionsAtom,
  adminUsersAtom,
  adminWorkspaceLogsAtom,
  instanceRequest,
} from "../../instance/instanceState";
import { useRefreshWhileSettling } from "../../instance/useRefreshWhileSettling";
import { useEnvironmentQuery } from "../../state/query";
import { Alert, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { describeDevice, workspaceStatusBadge, workspaceSummaryBadge } from "./AccountSettings";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

function errorText(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}

function formatBytes(bytes: number | null) {
  if (bytes === null) return "unknown";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatDate(iso: string | null) {
  return iso === null ? "Never" : new Date(iso).toLocaleString();
}

/** Runs an admin mutation with a toast on failure; returns whether it succeeded. */
async function mutate(title: string, run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return true;
  } catch (cause) {
    toastManager.add({ type: "error", title, description: errorText(cause) });
    return false;
  }
}

function QueryError({ error }: { error: string | null }) {
  return error ? (
    <Alert variant="error">
      <AlertDescription>{error}</AlertDescription>
    </Alert>
  ) : null;
}

function ToolChecklist({
  tools,
  selected,
  onChange,
}: {
  tools: ReadonlyArray<InstanceTool>;
  selected: ReadonlyArray<string>;
  onChange: (next: ReadonlyArray<string>) => void;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {tools.map((tool) => {
        const checked = selected.includes(tool.id);
        return (
          <label key={tool.id} className="flex items-start gap-2 text-sm">
            <Checkbox
              checked={checked}
              onCheckedChange={(value) =>
                onChange(value ? [...selected, tool.id] : selected.filter((id) => id !== tool.id))
              }
            />
            <span>
              <span className="font-medium">{tool.label}</span>
              <span className="block text-xs text-muted-foreground">{tool.description}</span>
            </span>
          </label>
        );
      })}
    </div>
  );
}

function LimitsFields({
  limits,
  onChange,
}: {
  limits: InstanceWorkspaceLimits;
  onChange: (next: InstanceWorkspaceLimits) => void;
}) {
  const field = (key: keyof InstanceWorkspaceLimits, label: string, step: string) => (
    <label className="grid gap-1 text-sm">
      <span className="text-xs text-muted-foreground">{label}</span>
      <Input
        nativeInput
        type="number"
        step={step}
        value={String(limits[key])}
        onChange={(event) => {
          const value = Number(event.currentTarget.value);
          if (Number.isFinite(value)) onChange({ ...limits, [key]: value });
        }}
      />
    </label>
  );
  return (
    <div className="grid gap-2 sm:grid-cols-3">
      {field("cpus", "CPUs", "0.5")}
      {field("memoryMb", "Memory (MB)", "256")}
      {field("pids", "Max processes", "64")}
    </div>
  );
}

function TemporaryPasswordNotice({ email, password }: { email: string; password: string }) {
  return (
    <Alert variant="info">
      <AlertDescription>
        <p>Temporary password for {email}:</p>
        <p className="font-mono text-foreground select-all">{password}</p>
        <p>Share it privately. They choose their own when they sign in. It won't be shown again.</p>
      </AlertDescription>
    </Alert>
  );
}

// Overview

export function AdminOverviewPanel() {
  const overview = useEnvironmentQuery(adminOverviewAtom);
  const data = overview.data;
  return (
    <SettingsPageContainer>
      <QueryError error={overview.error} />
      <SettingsSection title={data?.name ?? "Instance"}>
        <SettingsRow title="Version" description={data?.serverVersion ?? "…"} />
        <SettingsRow
          title="Users"
          description={
            data
              ? `${data.users} total · ${data.admins} admin${data.admins === 1 ? "" : "s"} · ${data.disabledUsers} disabled`
              : "…"
          }
          control={
            <Button render={<Link to="/settings/admin/users" />} size="sm" variant="outline">
              Manage users
            </Button>
          }
        />
        <SettingsRow
          title="Workspaces"
          description={data ? `${data.workspacesRunning} of ${data.workspacesTotal} running` : "…"}
        />
        <SettingsRow
          title="Memory limits"
          description={
            data
              ? `${formatBytes(data.committedMemoryBytes)} across workspaces that aren't stopped${
                  data.runtime.memoryBytes
                    ? `, on a host with ${formatBytes(data.runtime.memoryBytes)}`
                    : ""
                }. Limits are caps, so they can add up to more than the host has.`
              : "…"
          }
          status={
            data?.runtime.memoryBytes && data.committedMemoryBytes > data.runtime.memoryBytes ? (
              <Badge variant="warning">Overcommitted</Badge>
            ) : null
          }
        />
      </SettingsSection>
      <SettingsSection title="Host">
        <SettingsRow
          title={data?.runtime.kind === "static" ? "Static development runtime" : "Docker"}
          description={
            data
              ? data.runtime.reachable
                ? [
                    data.runtime.version ? `Engine ${data.runtime.version}` : null,
                    data.runtime.cpus ? `${data.runtime.cpus} CPUs` : null,
                    data.runtime.memoryBytes
                      ? `${formatBytes(data.runtime.memoryBytes)} memory`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ") || "Reachable"
                : (data.runtime.message ?? "Unreachable")
              : "…"
          }
          status={
            data ? (
              data.runtime.reachable ? (
                <Badge variant="success">Healthy</Badge>
              ) : (
                <Badge variant="error">Unreachable</Badge>
              )
            ) : null
          }
        />
        <SettingsRow
          title="Tailscale"
          description={
            data
              ? data.tailscale.mode === "none"
                ? "Not configured. Workspaces can't join the tailnet."
                : `${data.tailscale.mode === "oauth" ? "OAuth client" : "Shared auth key"} · workspaces tagged ${data.tailscale.tag ?? ""}`
              : "…"
          }
          status={
            data ? (
              data.tailscale.mode === "none" ? (
                <Badge variant="warning">Not configured</Badge>
              ) : (
                <Badge variant="success">Configured</Badge>
              )
            ) : null
          }
        />
        {data?.tailscale.instanceUrl ? (
          <SettingsRow title="Instance address" description={data.tailscale.instanceUrl} />
        ) : null}
      </SettingsSection>
    </SettingsPageContainer>
  );
}

// Users

function CreateUserDialog({ onCreated }: { onCreated: () => void }) {
  const tools = useEnvironmentQuery(adminToolsAtom);
  const settings = useEnvironmentQuery(adminSettingsAtom);
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<InstanceUserRole>("member");
  const [selectedTools, setSelectedTools] = useState<ReadonlyArray<string> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ email: string; password: string } | null>(null);

  const chosenTools = selectedTools ?? settings.data?.defaultTools ?? [];

  const reset = () => {
    setEmail("");
    setName("");
    setRole("member");
    setSelectedTools(null);
    setError(null);
    setCreated(null);
  };

  const submit = async (event: React.SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await instanceRequest((client, headers) =>
        client.admin.createUser({
          headers,
          payload: { email, name, role, tools: chosenTools },
        }),
      );
      setCreated({ email: result.user.email, password: result.temporaryPassword });
      onCreated();
    } catch (cause) {
      setError(errorText(cause));
    }
    setBusy(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <Button size="sm" onClick={() => setOpen(true)}>
        Add user
      </Button>
      <DialogPopup className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Add user</DialogTitle>
          <DialogDescription>
            Creates the account and a workspace with the tools you pick.
          </DialogDescription>
        </DialogHeader>
        {created ? (
          <>
            <DialogPanel>
              <TemporaryPasswordNotice email={created.email} password={created.password} />
            </DialogPanel>
            <DialogFooter>
              <Button size="sm" onClick={() => setOpen(false)}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form className="flex min-h-0 flex-col" onSubmit={(event) => void submit(event)}>
            <DialogPanel>
              <div className="grid gap-3">
                <label className="grid gap-1 text-sm">
                  <span className="font-medium">Email</span>
                  <Input
                    autoComplete="off"
                    nativeInput
                    onChange={(event) => setEmail(event.currentTarget.value)}
                    type="email"
                    value={email}
                  />
                </label>
                <label className="grid gap-1 text-sm">
                  <span className="font-medium">Name</span>
                  <Input
                    autoComplete="off"
                    nativeInput
                    onChange={(event) => setName(event.currentTarget.value)}
                    value={name}
                  />
                </label>
                <div className="grid gap-1 text-sm">
                  <span className="font-medium">Role</span>
                  <Select
                    value={role}
                    onValueChange={(value) => setRole(value === "admin" ? "admin" : "member")}
                  >
                    <SelectTrigger size="sm" aria-label="Role">
                      <SelectValue>{role === "admin" ? "Admin" : "Member"}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      <SelectItem value="member">Member</SelectItem>
                      <SelectItem value="admin">Admin</SelectItem>
                    </SelectPopup>
                  </Select>
                </div>
                <div className="grid gap-2 text-sm">
                  <span className="font-medium">Tools</span>
                  <ToolChecklist
                    tools={tools.data?.tools ?? []}
                    selected={chosenTools}
                    onChange={setSelectedTools}
                  />
                </div>
                {error ? (
                  <Alert variant="error">
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                ) : null}
              </div>
            </DialogPanel>
            <DialogFooter>
              <Button
                disabled={busy || email.trim() === "" || name.trim() === ""}
                size="sm"
                type="submit"
              >
                {busy ? "Creating…" : "Create user"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogPopup>
    </Dialog>
  );
}

export function AdminUsersPanel() {
  const users = useEnvironmentQuery(adminUsersAtom);
  useRefreshWhileSettling(users, users.data?.users.flatMap((entry) => entry.workspaces) ?? []);
  return (
    <SettingsPageContainer>
      <QueryError error={users.error} />
      <SettingsSection title="Users" headerAction={<CreateUserDialog onCreated={users.refresh} />}>
        {(users.data?.users ?? []).map(({ user, workspaces }) => (
          <SettingsRow
            key={user.id}
            title={
              <span className="flex items-center gap-2">
                {user.name}
                {user.role === "admin" ? <Badge variant="secondary">Admin</Badge> : null}
                {user.disabled ? <Badge variant="outline">Disabled</Badge> : null}
              </span>
            }
            description={`${user.email} · last sign-in ${formatDate(user.lastLoginAt)}`}
            status={workspaceSummaryBadge(workspaces)}
            control={
              <Button
                render={<Link to="/settings/admin/users/$userId" params={{ userId: user.id }} />}
                size="sm"
                variant="outline"
              >
                Manage
              </Button>
            }
          />
        ))}
        {users.data && users.data.users.length === 0 ? (
          <SettingsRow title="No users yet" description="Add the first person to this instance." />
        ) : null}
      </SettingsSection>
    </SettingsPageContainer>
  );
}

const WORKSPACE_ACTIONS: ReadonlyArray<{ action: InstanceWorkspaceAction; label: string }> = [
  { action: "start", label: "Start" },
  { action: "stop", label: "Stop" },
  { action: "restart", label: "Restart" },
  { action: "recreate", label: "Recreate" },
];

/** Warns when a new workspace's memory limit would push the total past the host's memory. */
function useMemoryWarning(memoryMb: number) {
  const overview = useEnvironmentQuery(adminOverviewAtom);
  const data = overview.data;
  if (!data?.runtime.memoryBytes) return null;
  const total = data.committedMemoryBytes + memoryMb * 1024 * 1024;
  return total > data.runtime.memoryBytes
    ? `Memory limits would add up to ${formatBytes(total)} on a host with ${formatBytes(data.runtime.memoryBytes)}. Limits are caps, so this works until the workspaces use it all at once.`
    : null;
}

function AddWorkspaceDialog({
  userId,
  onCreated,
}: {
  userId: InstanceUserId;
  onCreated: () => void;
}) {
  const tools = useEnvironmentQuery(adminToolsAtom);
  const settings = useEnvironmentQuery(adminSettingsAtom);
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [selectedTools, setSelectedTools] = useState<ReadonlyArray<string> | null>(null);
  const [selectedLimits, setSelectedLimits] = useState<InstanceWorkspaceLimits | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chosenTools = selectedTools ?? settings.data?.defaultTools ?? [];
  const chosenLimits = selectedLimits ?? settings.data?.defaultLimits ?? null;
  const memoryWarning = useMemoryWarning(chosenLimits?.memoryMb ?? 0);

  const reset = () => {
    setLabel("");
    setSelectedTools(null);
    setSelectedLimits(null);
    setError(null);
  };

  const submit = async (event: React.SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await instanceRequest((client, headers) =>
        client.admin.createWorkspace({
          headers,
          params: { userId },
          payload: {
            label: label.trim(),
            tools: chosenTools,
            ...(chosenLimits ? { limits: chosenLimits } : {}),
          },
        }),
      );
      setOpen(false);
      reset();
      onCreated();
    } catch (cause) {
      setError(errorText(cause));
    }
    setBusy(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        Add workspace
      </Button>
      <DialogPopup className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Add workspace</DialogTitle>
          <DialogDescription>
            A separate container with its own files, tailnet address, tools and limits.
          </DialogDescription>
        </DialogHeader>
        <form className="flex min-h-0 flex-col" onSubmit={(event) => void submit(event)}>
          <DialogPanel>
            <div className="grid gap-3">
              <label className="grid gap-1 text-sm">
                <span className="font-medium">Name</span>
                <Input
                  autoComplete="off"
                  maxLength={40}
                  nativeInput
                  onChange={(event) => setLabel(event.currentTarget.value)}
                  placeholder="Frontend"
                  value={label}
                />
              </label>
              <div className="grid gap-2 text-sm">
                <span className="font-medium">Tools</span>
                <ToolChecklist
                  tools={tools.data?.tools ?? []}
                  selected={chosenTools}
                  onChange={setSelectedTools}
                />
              </div>
              {chosenLimits ? (
                <div className="grid gap-2 text-sm">
                  <span className="font-medium">Resources</span>
                  <LimitsFields limits={chosenLimits} onChange={setSelectedLimits} />
                </div>
              ) : null}
              {memoryWarning ? (
                <Alert variant="warning">
                  <AlertDescription>{memoryWarning}</AlertDescription>
                </Alert>
              ) : null}
              {error ? (
                <Alert variant="error">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              ) : null}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button disabled={busy || label.trim() === ""} size="sm" type="submit">
              {busy ? "Creating…" : "Create workspace"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

function AdminWorkspaceSection({
  workspace,
  isOnly,
  onChanged,
}: {
  workspace: InstanceWorkspace;
  isOnly: boolean;
  onChanged: () => void;
}) {
  const workspaceId = workspace.id;
  const logs = useEnvironmentQuery(adminWorkspaceLogsAtom(workspaceId));
  const tools = useEnvironmentQuery(adminToolsAtom);
  const [editingLabel, setEditingLabel] = useState<string | null>(null);
  const [editingTools, setEditingTools] = useState<ReadonlyArray<string> | null>(null);
  const [editingLimits, setEditingLimits] = useState<InstanceWorkspaceLimits | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteData, setDeleteData] = useState(false);
  const [showLogs, setShowLogs] = useState(false);

  const workspaceAction = (action: InstanceWorkspaceAction) =>
    mutate(`Couldn't ${action} the workspace`, () =>
      instanceRequest((client, headers) =>
        client.admin.workspaceAction({ headers, params: { workspaceId, action } }),
      ),
    ).then((ok) => ok && onChanged());

  const saveWorkspace = (payload: {
    label?: string;
    tools?: ReadonlyArray<string>;
    limits?: InstanceWorkspaceLimits;
  }) =>
    mutate("Couldn't update the workspace", () =>
      instanceRequest((client, headers) =>
        client.admin.updateWorkspace({ headers, params: { workspaceId }, payload }),
      ),
    ).then((ok) => {
      if (!ok) return;
      setEditingLabel(null);
      setEditingTools(null);
      setEditingLimits(null);
      onChanged();
    });

  const makeDefault = () =>
    mutate("Couldn't change the default workspace", () =>
      instanceRequest((client, headers) =>
        client.admin.setDefaultWorkspace({ headers, params: { workspaceId } }),
      ),
    ).then((ok) => ok && onChanged());

  const deleteWorkspace = () =>
    mutate("Couldn't delete the workspace", () =>
      instanceRequest((client, headers) =>
        client.admin.deleteWorkspace({ headers, params: { workspaceId }, payload: { deleteData } }),
      ),
    ).then((ok) => ok && onChanged());

  return (
    <SettingsSection
      title={isOnly ? "Workspace" : workspace.label}
      titleAction={
        !isOnly && workspace.isDefault ? <Badge variant="secondary">Default</Badge> : null
      }
    >
      <SettingsRow
        title="Status"
        description={[
          workspace.tailnetHostname ?? workspace.statusMessage,
          `disk ${formatBytes(workspace.diskUsageBytes)}`,
          workspace.image,
        ]
          .filter(Boolean)
          .join(" · ")}
        status={workspaceStatusBadge(workspace)}
      />
      <SettingsRow
        title="Name"
        description={
          workspace.isDefault
            ? `${workspace.label}. The user's default workspace, which their apps open first.`
            : workspace.label
        }
        control={
          editingLabel === null ? (
            <div className="flex flex-wrap justify-end gap-1">
              <Button size="sm" variant="outline" onClick={() => setEditingLabel(workspace.label)}>
                Rename
              </Button>
              {workspace.isDefault ? null : (
                <Button size="sm" variant="outline" onClick={() => void makeDefault()}>
                  Make default
                </Button>
              )}
            </div>
          ) : null
        }
      >
        {editingLabel !== null ? (
          <form
            className="mt-3 flex max-w-md gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void saveWorkspace({ label: editingLabel.trim() });
            }}
          >
            <Input
              aria-label="Workspace name"
              maxLength={40}
              nativeInput
              onChange={(event) => setEditingLabel(event.currentTarget.value)}
              value={editingLabel}
            />
            <Button disabled={editingLabel.trim() === ""} size="sm" type="submit">
              Save
            </Button>
            <Button size="sm" variant="outline" onClick={() => setEditingLabel(null)}>
              Cancel
            </Button>
          </form>
        ) : null}
      </SettingsRow>
      <SettingsRow
        title="Controls"
        description="Recreate starts a fresh container on the same home volume, for image or tool changes."
        control={
          <div className="flex flex-wrap justify-end gap-1">
            {WORKSPACE_ACTIONS.map(({ action, label }) => (
              <Button
                key={action}
                size="sm"
                variant="outline"
                onClick={() => void workspaceAction(action)}
              >
                {label}
              </Button>
            ))}
          </div>
        }
      />
      <SettingsRow
        title="Tools"
        description={workspace.tools.join(", ") || "None"}
        control={
          editingTools === null ? (
            <Button size="sm" variant="outline" onClick={() => setEditingTools(workspace.tools)}>
              Edit
            </Button>
          ) : null
        }
      >
        {editingTools !== null ? (
          <div className="mt-3 grid gap-3">
            <ToolChecklist
              tools={tools.data?.tools ?? []}
              selected={editingTools}
              onChange={setEditingTools}
            />
            <div className="flex gap-2">
              <Button size="sm" onClick={() => void saveWorkspace({ tools: editingTools })}>
                Save and recreate
              </Button>
              <Button size="sm" variant="outline" onClick={() => setEditingTools(null)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : null}
      </SettingsRow>
      <SettingsRow
        title="Resources"
        description={`${workspace.limits.cpus} CPUs · ${workspace.limits.memoryMb} MB memory · ${workspace.limits.pids} processes`}
        control={
          editingLimits === null ? (
            <Button size="sm" variant="outline" onClick={() => setEditingLimits(workspace.limits)}>
              Edit
            </Button>
          ) : null
        }
      >
        {editingLimits !== null ? (
          <div className="mt-3 grid gap-3">
            <LimitsFields limits={editingLimits} onChange={setEditingLimits} />
            <div className="flex gap-2">
              <Button size="sm" onClick={() => void saveWorkspace({ limits: editingLimits })}>
                Save and recreate
              </Button>
              <Button size="sm" variant="outline" onClick={() => setEditingLimits(null)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : null}
      </SettingsRow>
      <SettingsRow
        title="Logs"
        description="Recent container output, including tool installation."
        control={
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setShowLogs(!showLogs);
              if (!showLogs) logs.refresh();
            }}
          >
            {showLogs ? "Hide" : "Show"}
          </Button>
        }
      >
        {showLogs ? (
          <pre className="mt-3 max-h-80 overflow-auto rounded-md border border-border bg-muted/30 p-2 text-xs whitespace-pre-wrap">
            {logs.data?.text ?? logs.error ?? "Loading…"}
          </pre>
        ) : null}
      </SettingsRow>
      <SettingsRow
        title="Delete workspace"
        description={
          isOnly
            ? "A user keeps at least one workspace. Delete the user to remove it."
            : "Removes the container and its tailnet device."
        }
        control={
          confirmDelete ? null : (
            <Button
              disabled={isOnly}
              size="sm"
              variant="destructive-outline"
              onClick={() => setConfirmDelete(true)}
            >
              Delete…
            </Button>
          )
        }
      >
        {confirmDelete ? (
          <div className="mt-3 grid gap-3">
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={deleteData} onCheckedChange={(value) => setDeleteData(value)} />
              Also delete this workspace's files. This can't be undone.
            </label>
            <div className="flex gap-2">
              <Button size="sm" variant="destructive" onClick={() => void deleteWorkspace()}>
                Delete {workspace.label}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setConfirmDelete(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : null}
      </SettingsRow>
    </SettingsSection>
  );
}

export function AdminUserDetailPanel({ userId }: { userId: InstanceUserId }) {
  const navigate = useNavigate();
  const detail = useEnvironmentQuery(adminUserAtom(userId));
  const sessions = useEnvironmentQuery(adminUserSessionsAtom(userId));
  const [temporaryPassword, setTemporaryPassword] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteData, setDeleteData] = useState(false);

  const user = detail.data?.user ?? null;
  const workspaces = detail.data?.workspaces ?? [];
  useRefreshWhileSettling(detail, workspaces);
  const refresh = () => {
    detail.refresh();
    sessions.refresh();
  };

  const update = (payload: { role?: InstanceUserRole; disabled?: boolean }) =>
    mutate("Couldn't update the user", () =>
      instanceRequest((client, headers) =>
        client.admin.updateUser({ headers, params: { userId }, payload }),
      ),
    ).then((ok) => ok && refresh());

  const resetPassword = () =>
    mutate("Couldn't reset the password", async () => {
      const result = await instanceRequest((client, headers) =>
        client.admin.resetPassword({ headers, params: { userId } }),
      );
      setTemporaryPassword(result.temporaryPassword);
      sessions.refresh();
    });

  const deleteUser = () =>
    mutate("Couldn't delete the user", () =>
      instanceRequest((client, headers) =>
        client.admin.deleteUser({ headers, params: { userId }, payload: { deleteData } }),
      ),
    ).then((ok) => {
      if (ok) void navigate({ to: "/settings/admin/users" });
    });

  const revokeSession = (sessionId: string) =>
    mutate("Couldn't sign out the device", () =>
      instanceRequest((client, headers) =>
        client.admin.revokeUserSession({ headers, params: { userId, sessionId } }),
      ),
    ).then((ok) => ok && sessions.refresh());

  const several = workspaces.length > 1;

  return (
    <SettingsPageContainer>
      <QueryError error={detail.error} />
      <div>
        <Button render={<Link to="/settings/admin/users" />} size="xs" variant="ghost">
          ← All users
        </Button>
      </div>
      {temporaryPassword && user ? (
        <TemporaryPasswordNotice email={user.email} password={temporaryPassword} />
      ) : null}
      <SettingsSection
        title={user?.name ?? "User"}
        headerAction={<AddWorkspaceDialog userId={userId} onCreated={refresh} />}
      >
        <SettingsRow
          title="Email"
          description={user ? `${user.email} · created ${formatDate(user.createdAt)}` : "…"}
        />
        <SettingsRow
          title="Role"
          description={user?.role === "admin" ? "Can manage users and the instance." : "Member"}
          control={
            user ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => void update({ role: user.role === "admin" ? "member" : "admin" })}
              >
                {user.role === "admin" ? "Make member" : "Make admin"}
              </Button>
            ) : null
          }
        />
        <SettingsRow
          title="Password"
          description={
            user?.mustChangePassword
              ? "Must choose a new password at next sign-in."
              : "Resetting signs the user out everywhere."
          }
          control={
            <Button size="sm" variant="outline" onClick={() => void resetPassword()}>
              Reset password
            </Button>
          }
        />
        <SettingsRow
          title={user?.disabled ? "Disabled" : "Active"}
          description={
            user?.disabled
              ? `Can't sign in. ${several ? "The workspaces are" : "The workspace is"} stopped and the data kept.`
              : `Disabling signs the user out and stops ${several ? "all their workspaces" : "their workspace"}.`
          }
          control={
            user ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => void update({ disabled: !user.disabled })}
              >
                {user.disabled ? "Enable" : "Disable"}
              </Button>
            ) : null
          }
        />
      </SettingsSection>

      {workspaces.map((workspace) => (
        <AdminWorkspaceSection
          key={workspace.id}
          isOnly={!several}
          workspace={workspace}
          onChanged={refresh}
        />
      ))}
      {detail.data && workspaces.length === 0 ? (
        <SettingsSection title="Workspace">
          <SettingsRow title="No workspace" status={workspaceStatusBadge(null)} />
        </SettingsSection>
      ) : null}

      <SettingsSection title="Signed-in devices">
        {(sessions.data?.sessions ?? []).map((session) => (
          <SettingsRow
            key={session.id}
            title={describeDevice(session)}
            description={`Signed in ${formatDate(session.issuedAt)}${session.ipAddress ? ` from ${session.ipAddress}` : ""}`}
            control={
              <Button size="sm" variant="outline" onClick={() => void revokeSession(session.id)}>
                Sign out
              </Button>
            }
          />
        ))}
        {sessions.data && sessions.data.sessions.length === 0 ? (
          <SettingsRow title="No signed-in devices" />
        ) : null}
      </SettingsSection>

      <SettingsSection title="Danger zone">
        <SettingsRow
          title="Delete user"
          description={
            several
              ? `Removes the account and all ${workspaces.length} of its workspace containers and tailnet devices.`
              : "Removes the account, its workspace container and its tailnet device."
          }
          control={
            confirmDelete ? null : (
              <Button
                size="sm"
                variant="destructive-outline"
                onClick={() => setConfirmDelete(true)}
              >
                Delete…
              </Button>
            )
          }
        >
          {confirmDelete ? (
            <div className="mt-3 grid gap-3">
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={deleteData} onCheckedChange={(value) => setDeleteData(value)} />
                {several
                  ? "Also delete the files of every workspace. This can't be undone."
                  : "Also delete the workspace's files. This can't be undone."}
              </label>
              <div className="flex gap-2">
                <Button size="sm" variant="destructive" onClick={() => void deleteUser()}>
                  Delete {user?.email ?? "user"}
                </Button>
                <Button size="sm" variant="outline" onClick={() => setConfirmDelete(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : null}
        </SettingsRow>
      </SettingsSection>
    </SettingsPageContainer>
  );
}

// Tools and defaults

export function AdminToolsPanel() {
  const tools = useEnvironmentQuery(adminToolsAtom);
  const settings = useEnvironmentQuery(adminSettingsAtom);
  const [draft, setDraft] = useState<InstanceSettings | null>(null);
  const [upgrading, setUpgrading] = useState(false);
  const current = draft ?? settings.data;

  const save = () =>
    current &&
    mutate("Couldn't save the defaults", () =>
      instanceRequest((client, headers) =>
        client.admin.updateSettings({ headers, payload: current }),
      ),
    ).then((ok) => {
      if (!ok) return;
      setDraft(null);
      settings.refresh();
      toastManager.add({ type: "success", title: "Defaults saved" });
    });

  const upgradeAll = async () => {
    setUpgrading(true);
    const ok = await mutate("Couldn't upgrade workspaces", async () => {
      const result = await instanceRequest((client, headers) =>
        client.admin.upgradeAllWorkspaces({ headers }),
      );
      toastManager.add({
        type: "info",
        title:
          result.recreated === 0
            ? "Every workspace already runs this image"
            : `Recreating ${result.recreated} workspace${result.recreated === 1 ? "" : "s"}`,
      });
    });
    setUpgrading(false);
    return ok;
  };

  return (
    <SettingsPageContainer>
      <QueryError error={settings.error ?? tools.error} />
      <SettingsSection
        title="Defaults for new workspaces"
        headerAction={
          draft ? (
            <Button size="sm" onClick={() => void save()}>
              Save
            </Button>
          ) : null
        }
      >
        <SettingsRow title="Tools" description="Preselected when you add a user or a workspace.">
          {current ? (
            <div className="mt-3">
              <ToolChecklist
                tools={tools.data?.tools ?? []}
                selected={current.defaultTools}
                onChange={(defaultTools) => setDraft({ ...current, defaultTools })}
              />
            </div>
          ) : null}
        </SettingsRow>
        <SettingsRow
          title="Resources"
          description="Each workspace's CPU, memory and process limits."
        >
          {current ? (
            <div className="mt-3">
              <LimitsFields
                limits={current.defaultLimits}
                onChange={(defaultLimits) => setDraft({ ...current, defaultLimits })}
              />
            </div>
          ) : null}
        </SettingsRow>
      </SettingsSection>
      <SettingsSection title="Workspace image">
        <SettingsRow
          title="Image"
          description="New and recreated workspaces use this image."
          control={
            current ? (
              <Input
                aria-label="Workspace image"
                nativeInput
                onChange={(event) =>
                  setDraft({ ...current, workspaceImage: event.currentTarget.value })
                }
                value={current.workspaceImage}
              />
            ) : null
          }
        />
        <SettingsRow
          title="Upgrade all workspaces"
          description="Recreates running workspaces that use a different image. Home folders are kept."
          control={
            <Button
              disabled={upgrading || draft !== null}
              size="sm"
              variant="outline"
              onClick={() => void upgradeAll()}
            >
              {upgrading ? "Upgrading…" : "Upgrade all"}
            </Button>
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}

// Instance

export function AdminInstancePanel() {
  const settings = useEnvironmentQuery(adminSettingsAtom);
  const [draft, setDraft] = useState<InstanceSettings | null>(null);
  const current = draft ?? settings.data;

  const save = () =>
    current &&
    mutate("Couldn't save instance settings", () =>
      instanceRequest((client, headers) =>
        client.admin.updateSettings({ headers, payload: current }),
      ),
    ).then((ok) => {
      if (!ok) return;
      setDraft(null);
      settings.refresh();
      toastManager.add({ type: "success", title: "Instance settings saved" });
    });

  return (
    <SettingsPageContainer>
      <QueryError error={settings.error} />
      <SettingsSection
        title="Instance"
        headerAction={
          draft ? (
            <Button size="sm" onClick={() => void save()}>
              Save
            </Button>
          ) : null
        }
      >
        <SettingsRow
          title="Name"
          description="Shown on the sign-in screen and in the apps."
          control={
            current ? (
              <Input
                aria-label="Instance name"
                nativeInput
                onChange={(event) => setDraft({ ...current, name: event.currentTarget.value })}
                value={current.name}
              />
            ) : null
          }
        />
        <SettingsRow
          title="Sign-in lifetime"
          description="Days before a device must sign in again. Applies to new sign-ins."
          control={
            current ? (
              <Input
                aria-label="Sign-in lifetime in days"
                nativeInput
                type="number"
                min={1}
                max={365}
                onChange={(event) => {
                  const days = Number(event.currentTarget.value);
                  if (Number.isInteger(days)) setDraft({ ...current, sessionTtlDays: days });
                }}
                value={String(current.sessionTtlDays)}
              />
            ) : null
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}

// Audit

export function AdminAuditPanel() {
  const [pages, setPages] = useState<ReadonlyArray<number | null>>([null]);
  return (
    <SettingsPageContainer>
      <SettingsSection title="Audit log">
        {pages.map((beforeId) => (
          <AuditPage
            key={beforeId ?? "latest"}
            beforeId={beforeId}
            onMore={(next) => setPages((current) => [...current, next])}
            isLast={beforeId === pages.at(-1)}
          />
        ))}
      </SettingsSection>
    </SettingsPageContainer>
  );
}

function AuditPage({
  beforeId,
  isLast,
  onMore,
}: {
  beforeId: number | null;
  isLast: boolean;
  onMore: (next: number) => void;
}) {
  const page = useEnvironmentQuery(adminAuditAtom(beforeId));
  return (
    <>
      {page.error ? (
        <SettingsRow title="Couldn't load the audit log" description={page.error} />
      ) : null}
      {(page.data?.events ?? []).map((event) => (
        <SettingsRow
          key={event.id}
          title={event.action}
          description={[
            formatDate(event.at),
            event.actorEmail ? `by ${event.actorEmail}` : "by the system",
            event.targetEmail && event.targetEmail !== event.actorEmail
              ? `for ${event.targetEmail}`
              : null,
            event.ipAddress,
            event.detail,
          ]
            .filter(Boolean)
            .join(" · ")}
        />
      ))}
      {isLast && page.data?.nextBeforeId != null ? (
        <SettingsRow
          title="Older events"
          control={
            <Button
              size="sm"
              variant="outline"
              onClick={() => page.data?.nextBeforeId != null && onMore(page.data.nextBeforeId)}
            >
              Load more
            </Button>
          }
        />
      ) : null}
    </>
  );
}
