import { formatTypingLabel } from "@t3tools/client-runtime/state/presence";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { useThreadPresence } from "../../state/presence";

/** Who else is typing in this thread, floated above the composer so it never moves it. */
export function ComposerTypingIndicator(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId | null;
}) {
  const { typers } = useThreadPresence(props.environmentId, props.threadId);
  const label = formatTypingLabel(typers.map((member) => member.name));
  return (
    <div className="relative h-0" aria-live="polite">
      {label === null ? null : (
        <p
          className="pointer-events-none absolute bottom-1 start-3 max-w-[calc(100%-1.5rem)] truncate text-2xs text-muted-foreground"
          data-composer-typing-indicator
        >
          {label}
        </p>
      )}
    </div>
  );
}
