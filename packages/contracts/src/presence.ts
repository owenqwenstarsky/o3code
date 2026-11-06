import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** What this connection is doing. Only the open thread and whether its composer is in use; never draft text. */
export const PresenceUpdateInput = Schema.Struct({
  viewingThreadId: Schema.NullOr(ThreadId),
  typingThreadId: Schema.NullOr(ThreadId),
});
export type PresenceUpdateInput = typeof PresenceUpdateInput.Type;

/** One member's presence, folded across their tabs and devices. */
export const PresenceMember = Schema.Struct({
  userId: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  viewingThreadIds: Schema.Array(ThreadId),
  typingThreadIds: Schema.Array(ThreadId),
});
export type PresenceMember = typeof PresenceMember.Type;

/** The other members present on a shared workspace. Never includes the subscriber. */
export const PresenceSnapshot = Schema.Struct({
  /** Which member this connection is; null on a server with no members. */
  viewerUserId: Schema.NullOr(TrimmedNonEmptyString),
  members: Schema.Array(PresenceMember),
});
export type PresenceSnapshot = typeof PresenceSnapshot.Type;
