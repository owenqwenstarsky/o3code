import type {
  InstanceAuthGroup,
  InstanceAuthGroupId,
  InstanceUserWithWorkspaces,
  InstanceWorkspaceId,
} from "@t3tools/contracts/instance";
import { useState } from "react";

import { adminAuthGroupsAtom, adminUsersAtom, instanceRequest } from "../../instance/instanceState";
import { useEnvironmentQuery } from "../../state/query";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { workspaceStatusBadge } from "./AccountSettings";
import { QueryError, mutate } from "./AdminSettings";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

const NO_GROUP = "none";

/** Moves a workspace into a sign-in sync group, or out of all of them with `null`. */
const setWorkspaceAuthGroup = (
  workspaceId: InstanceWorkspaceId,
  groupId: InstanceAuthGroupId | null,
) =>
  mutate("Couldn't change sign-in sync", () =>
    instanceRequest((client, headers) =>
      client.admin.setWorkspaceAuthGroup({
        headers,
        params: { workspaceId },
        payload: { groupId },
      }),
    ),
  );

/** The sign-in sync group picker for one workspace, shown on the user page. */
export function WorkspaceAuthGroupRow({ workspaceId }: { workspaceId: InstanceWorkspaceId }) {
  const groups = useEnvironmentQuery(adminAuthGroupsAtom);
  const current =
    groups.data?.groups.find((group) => group.workspaceIds.includes(workspaceId)) ?? null;
  return (
    <SettingsRow
      title="Sign-in sync"
      description={
        current
          ? `Shares agent sign-ins with the other workspaces in ${current.name}.`
          : "Agent sign-ins stay in this workspace."
      }
      control={
        <Select
          value={current?.id ?? NO_GROUP}
          onValueChange={(value) => {
            const next = groups.data?.groups.find((group) => group.id === value)?.id ?? null;
            void setWorkspaceAuthGroup(workspaceId, next).then((ok) => ok && groups.refresh());
          }}
        >
          <SelectTrigger size="sm" aria-label="Sign-in sync group">
            <SelectValue>{current?.name ?? "Not synced"}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value={NO_GROUP}>Not synced</SelectItem>
            {(groups.data?.groups ?? []).map((group) => (
              <SelectItem key={group.id} value={group.id}>
                {group.name}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}

function NameForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: string;
  submitLabel: string;
  onSubmit: (name: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial);
  return (
    <form
      className="mt-3 flex max-w-md gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void onSubmit(name.trim());
      }}
    >
      <Input
        aria-label="Group name"
        maxLength={60}
        nativeInput
        onChange={(event) => setName(event.currentTarget.value)}
        placeholder="Team Claude"
        value={name}
      />
      <Button disabled={name.trim() === ""} size="sm" type="submit">
        {submitLabel}
      </Button>
      <Button size="sm" variant="outline" onClick={onCancel}>
        Cancel
      </Button>
    </form>
  );
}

interface WorkspaceChoice {
  readonly id: InstanceWorkspaceId;
  readonly label: string;
  readonly workspace: InstanceUserWithWorkspaces["workspaces"][number];
}

function workspaceChoices(users: ReadonlyArray<InstanceUserWithWorkspaces>) {
  return users.flatMap(({ user, workspaces }) =>
    workspaces.map((workspace): WorkspaceChoice => ({
      id: workspace.id,
      label: workspaces.length > 1 ? `${user.name} · ${workspace.label}` : user.name,
      workspace,
    })),
  );
}

function AuthGroupSection({
  group,
  groups,
  choices,
  onChanged,
}: {
  group: InstanceAuthGroup;
  groups: ReadonlyArray<InstanceAuthGroup>;
  choices: ReadonlyArray<WorkspaceChoice>;
  onChanged: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const members = group.workspaceIds.flatMap((id) => choices.filter((choice) => choice.id === id));
  const candidates = choices.filter((choice) => !group.workspaceIds.includes(choice.id));
  const groupOf = (id: InstanceWorkspaceId) =>
    groups.find((candidate) => candidate.workspaceIds.includes(id));

  const rename = (name: string) =>
    mutate("Couldn't rename the group", () =>
      instanceRequest((client, headers) =>
        client.admin.renameAuthGroup({ headers, params: { groupId: group.id }, payload: { name } }),
      ),
    ).then((ok) => {
      if (ok) {
        setRenaming(false);
        onChanged();
      }
      return ok;
    });

  const remove = () =>
    mutate("Couldn't delete the group", () =>
      instanceRequest((client, headers) =>
        client.admin.deleteAuthGroup({ headers, params: { groupId: group.id } }),
      ),
    ).then((ok) => ok && onChanged());

  return (
    <SettingsSection
      title={group.name}
      headerAction={
        renaming || confirmDelete ? null : (
          <div className="flex gap-1">
            <Button size="sm" variant="outline" onClick={() => setRenaming(true)}>
              Rename
            </Button>
            <Button size="sm" variant="destructive-outline" onClick={() => setConfirmDelete(true)}>
              Delete…
            </Button>
          </div>
        )
      }
    >
      {renaming ? (
        <SettingsRow title="Name">
          <NameForm
            initial={group.name}
            submitLabel="Save"
            onSubmit={rename}
            onCancel={() => setRenaming(false)}
          />
        </SettingsRow>
      ) : null}
      {confirmDelete ? (
        <SettingsRow
          title="Delete this group?"
          description="Its workspaces stop syncing and keep the sign-ins they have now."
          control={
            <div className="flex gap-1">
              <Button size="sm" variant="destructive" onClick={() => void remove()}>
                Delete {group.name}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setConfirmDelete(false)}>
                Cancel
              </Button>
            </div>
          }
        />
      ) : null}
      {members.map((member) => (
        <SettingsRow
          key={member.id}
          title={member.label}
          description={member.workspace.tailnetHostname ?? member.workspace.slug}
          status={workspaceStatusBadge(member.workspace)}
          control={
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                void setWorkspaceAuthGroup(member.id, null).then((ok) => ok && onChanged())
              }
            >
              Remove
            </Button>
          }
        />
      ))}
      {members.length === 0 ? (
        <SettingsRow
          title="No workspaces yet"
          description="Add the workspaces that should share."
        />
      ) : null}
      {candidates.length > 0 ? (
        <SettingsRow
          title="Add a workspace"
          description="It takes this group's sign-ins and keeps a backup of its own."
          control={
            <Select
              value=""
              onValueChange={(value) => {
                const choice = candidates.find((candidate) => candidate.id === value);
                if (choice) {
                  void setWorkspaceAuthGroup(choice.id, group.id).then((ok) => ok && onChanged());
                }
              }}
            >
              <SelectTrigger size="sm" aria-label={`Add a workspace to ${group.name}`}>
                <SelectValue>Choose…</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {candidates.map((choice) => {
                  const elsewhere = groupOf(choice.id);
                  return (
                    <SelectItem key={choice.id} value={choice.id}>
                      {elsewhere ? `${choice.label} (from ${elsewhere.name})` : choice.label}
                    </SelectItem>
                  );
                })}
              </SelectPopup>
            </Select>
          }
        />
      ) : null}
    </SettingsSection>
  );
}

export function AdminAuthSyncPanel() {
  const groups = useEnvironmentQuery(adminAuthGroupsAtom);
  const users = useEnvironmentQuery(adminUsersAtom);
  const [creating, setCreating] = useState(false);
  const choices = workspaceChoices(users.data?.users ?? []);
  const refresh = () => {
    groups.refresh();
    users.refresh();
  };

  const create = (name: string) =>
    mutate("Couldn't create the group", () =>
      instanceRequest((client, headers) =>
        client.admin.createAuthGroup({ headers, payload: { name } }),
      ),
    ).then((ok) => {
      if (ok) {
        setCreating(false);
        groups.refresh();
      }
      return ok;
    });

  return (
    <SettingsPageContainer>
      <QueryError error={groups.error ?? users.error} />
      <SettingsSection
        title="Sign-in sync"
        headerAction={
          creating ? null : (
            <Button size="sm" onClick={() => setCreating(true)}>
              New group
            </Button>
          )
        }
      >
        <SettingsRow
          title="Share agent sign-ins between workspaces"
          description="Workspaces in a group share their Claude Code, Codex, Grok and OpenCode sign-ins, and nothing else. Signing in or out in one reaches the rest within seconds. Personal subscriptions may not allow sharing between people."
        >
          {creating ? (
            <NameForm
              initial=""
              submitLabel="Create group"
              onSubmit={create}
              onCancel={() => setCreating(false)}
            />
          ) : null}
        </SettingsRow>
      </SettingsSection>
      {(groups.data?.groups ?? []).map((group) => (
        <AuthGroupSection
          key={group.id}
          group={group}
          groups={groups.data?.groups ?? []}
          choices={choices}
          onChanged={refresh}
        />
      ))}
    </SettingsPageContainer>
  );
}
