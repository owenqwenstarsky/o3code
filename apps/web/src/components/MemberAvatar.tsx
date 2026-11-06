import { providerInstanceInitials } from "@t3tools/client-runtime/state/provider-instance-display";

import { cn } from "~/lib/utils";

interface Member {
  readonly userId: string;
  readonly name: string;
}

// Full class names so Tailwind keeps them; each member keeps one colour on every device.
const MEMBER_COLORS = [
  "bg-sky-500 text-white",
  "bg-violet-500 text-white",
  "bg-emerald-600 text-white",
  "bg-amber-500 text-white",
  "bg-rose-500 text-white",
  "bg-teal-600 text-white",
  "bg-indigo-500 text-white",
  "bg-orange-500 text-white",
] as const;

function memberColor(userId: string): string {
  let hash = 2166136261;
  for (let index = 0; index < userId.length; index += 1) {
    hash = Math.imul(hash ^ userId.charCodeAt(index), 16777619);
  }
  return MEMBER_COLORS[(hash >>> 0) % MEMBER_COLORS.length]!;
}

const SIZE_CLASS = {
  "2xs": "size-3 text-5xs",
  xs: "size-4 text-5xs",
  sm: "size-5 text-4xs",
} as const;

export function MemberAvatar(props: {
  member: Member;
  size?: keyof typeof SIZE_CLASS;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold leading-none",
        SIZE_CLASS[props.size ?? "sm"],
        memberColor(props.member.userId),
        props.className,
      )}
    >
      {providerInstanceInitials(props.member.name)}
    </span>
  );
}

/** Overlapping avatars of the members present, like a shared document's header. */
export function MemberAvatarStack(props: {
  members: ReadonlyArray<Member>;
  max?: number;
  size?: keyof typeof SIZE_CLASS;
}) {
  const max = props.max ?? 3;
  if (props.members.length === 0) return null;
  const shown = props.members.slice(0, max);
  const hidden = props.members.length - shown.length;
  const label = props.members.map((member) => member.name).join(", ");
  return (
    <span className="inline-flex shrink-0 items-center" role="img" aria-label={`Here: ${label}`}>
      {shown.map((member, index) => (
        <MemberAvatar
          key={member.userId}
          member={member}
          size={props.size ?? "xs"}
          className={cn("ring-1 ring-background", index > 0 && "-ms-1")}
        />
      ))}
      {hidden > 0 ? (
        <span
          aria-hidden
          className={cn(
            "-ms-1 inline-flex items-center justify-center rounded-full bg-muted font-semibold text-muted-foreground leading-none ring-1 ring-background",
            SIZE_CLASS[props.size ?? "xs"],
          )}
        >
          +{hidden}
        </span>
      ) : null}
    </span>
  );
}
