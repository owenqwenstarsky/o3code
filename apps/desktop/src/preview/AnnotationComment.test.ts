import { expect, it } from "vite-plus/test";
import { trackAnnotationComment } from "./AnnotationComment.ts";

it("submits only the retained trusted input and restores injected textarea text before editing", () => {
  const listeners = new Map<string, (event: { isTrusted: boolean }) => void>();
  const comment = {
    value: "",
    addEventListener: (name: string, listener: (event: { isTrusted: boolean }) => void) => {
      listeners.set(name, listener);
    },
  };
  const submittedComment = trackAnnotationComment(comment as unknown as HTMLTextAreaElement);
  comment.value = "  user comment  ";
  listeners.get("input")!({ isTrusted: true });
  comment.value = "injected send";
  expect(submittedComment()).toBe("user comment");
  listeners.get("input")!({ isTrusted: false });
  expect(comment.value).toBe("  user comment  ");
  comment.value = "injected prefix";
  listeners.get("beforeinput")!({ isTrusted: true });
  expect(comment.value).toBe("  user comment  ");
  comment.value = "edited comment";
  listeners.get("input")!({ isTrusted: true });
  expect(submittedComment()).toBe("edited comment");
});
