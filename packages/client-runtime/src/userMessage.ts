import {
  type ChatAttachment,
  type ChatFileAttachment,
  type GuestMessageAttribution,
  type OrchestrationMessageContext,
  type OrchestrationV2Actor,
  type OrchestrationV2CreationSource,
  type OrchestrationV2IdleCompaction,
  type OrchestrationV2Member,
  type OrchestrationV2UserMessageInputIntent,
  ScheduledTaskId,
} from "@t3tools/contracts";
import {
  isAttachmentOnlyBootstrapPrompt,
  replaceComposerContextReferences,
} from "@t3tools/shared/composerContextReferences";
import { filePreviewKind } from "@t3tools/shared/filePreview";
import { imageMimeType } from "@t3tools/shared/image";
import { videoMimeType } from "@t3tools/shared/video";

/** The working row while T3 Code's own compaction runs. */
export const IDLE_COMPACTING_LABELS = {
  beforeCacheExpires: "Compacting before the cache expires…",
  onReturn: "Compacting…",
} satisfies Record<OrchestrationV2IdleCompaction, string>;

/** Leads the finished compaction's token counts, in place of "Context compacted". */
export const IDLE_COMPACTION_TITLES = {
  beforeCacheExpires: "Context automatically compacted before cache expiry",
  onReturn: "Context compacted before sending",
} satisfies Record<OrchestrationV2IdleCompaction, string>;

const LEGACY_AUTOMATION_PREFIX = /^\[Triggered by schedule task: [^\r\n]+\]\r?\n\r?\n/;
const LEGACY_AUTOMATION_MESSAGE_ID = /^scheduled-task-message:(.+):\d+:(?:scheduled|manual)$/;

export function resolveUserMessageFileCards(message: {
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly context?: OrchestrationMessageContext | undefined;
}): ReadonlyArray<ChatFileAttachment> | null {
  const files = message.attachments.filter(
    (attachment): attachment is ChatFileAttachment =>
      attachment.type === "file" &&
      imageMimeType(attachment) === null &&
      videoMimeType(attachment) === null &&
      filePreviewKind(attachment) !== "audio",
  );
  if (files.length === 0 || files.length !== message.attachments.length) return null;
  const fileIds = new Set(files.map((file) => file.id));
  const remaining = replaceComposerContextReferences(message.text, (reference) => {
    const record = message.context?.records.find((item) => item.contextId === reference.contextId);
    return reference.kind === "file" &&
      record?.kind === "file" &&
      "attachmentId" in record &&
      fileIds.has(record.attachmentId)
      ? ""
      : reference.label || reference.kind;
  });
  return remaining.trim() === "" ? files : null;
}

/**
 * `viewerUserId` is which shared-workspace member is looking; another member's message is
 * attributed to them. Without one (a server with no members), every user message is your own.
 */
export function resolveUserMessagePresentation(
  message: {
    readonly id?: string;
    readonly role: string;
    readonly text: string;
    readonly createdBy?: OrchestrationV2Actor;
    readonly creationSource?: OrchestrationV2CreationSource;
    readonly author?: OrchestrationV2Member | undefined;
    readonly scheduledTaskId?: ScheduledTaskId | undefined;
    readonly context?: { readonly guest?: GuestMessageAttribution | undefined } | undefined;
  },
  viewerUserId?: string | null,
): {
  readonly text: string;
  readonly attribution: "automation" | "agent" | "t3code" | "guest" | "member" | null;
  readonly scheduledTaskId: ScheduledTaskId | undefined;
  /** Set when `attribution` is "guest". */
  readonly guestName?: string;
  /** Set when `attribution` is "member". */
  readonly author?: OrchestrationV2Member;
} {
  if (message.role !== "user") {
    return { text: message.text, attribution: null, scheduledTaskId: undefined };
  }
  // The stored text names the guest for the agent; people see the guest's own words.
  const guest = message.context?.guest;
  if (guest !== undefined) {
    return {
      text: guest.text,
      attribution: "guest",
      scheduledTaskId: undefined,
      guestName: guest.name,
    };
  }
  if (message.scheduledTaskId !== undefined) {
    return {
      text: message.text,
      attribution: "automation",
      scheduledTaskId: message.scheduledTaskId,
    };
  }
  const legacyPrefix = LEGACY_AUTOMATION_PREFIX.exec(message.text);
  const legacyTaskId = legacyPrefix
    ? LEGACY_AUTOMATION_MESSAGE_ID.exec(message.id ?? "")?.[1]
    : undefined;
  if (legacyPrefix !== null && (legacyTaskId !== undefined || message.createdBy === "agent")) {
    return {
      text: message.text.slice(legacyPrefix[0].length),
      attribution: "automation",
      scheduledTaskId: legacyTaskId === undefined ? undefined : ScheduledTaskId.make(legacyTaskId),
    };
  }
  // The agent needs words to start a turn; people sent only the attachments.
  const text = isAttachmentOnlyBootstrapPrompt(message.text) ? "" : message.text;
  if (message.createdBy === "agent") {
    return {
      text,
      attribution: message.creationSource === "server" ? "t3code" : "agent",
      scheduledTaskId: undefined,
    };
  }
  const author = message.author;
  if (author !== undefined && viewerUserId != null && author.userId !== viewerUserId) {
    return { text, attribution: "member", scheduledTaskId: undefined, author };
  }
  return { text, attribution: null, scheduledTaskId: undefined };
}

type GroupableUserMessage = Parameters<typeof resolveUserMessagePresentation>[0] & {
  readonly inputIntent?: OrchestrationV2UserMessageInputIntent;
};

/** Messages a person typed group with their neighbours from the same person. */
export function resolveUserMessageGrouping(
  message: GroupableUserMessage | undefined,
  previous: GroupableUserMessage | undefined,
  next: GroupableUserMessage | undefined,
) {
  const isPersonMessage = (value: GroupableUserMessage | undefined) =>
    value?.role === "user" && resolveUserMessagePresentation(value).attribution === null;
  const groups = (other: GroupableUserMessage | undefined) =>
    isPersonMessage(message) &&
    isPersonMessage(other) &&
    message?.author?.userId === other?.author?.userId;
  const isSteer = (value: GroupableUserMessage | undefined) =>
    value?.inputIntent === "steer" || value?.inputIntent === "promoted_queued_to_steer";
  const groupedWithPrevious = groups(previous);
  return {
    groupedWithPrevious,
    groupedWithNext: groups(next),
    continuesSteer: groupedWithPrevious && isSteer(message) && isSteer(previous),
  };
}
