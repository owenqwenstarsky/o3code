export function trackAnnotationComment(comment: HTMLTextAreaElement): () => string {
  let value = "";
  comment.addEventListener("beforeinput", (event) => {
    if (event.isTrusted && comment.value !== value) comment.value = value;
  });
  comment.addEventListener("input", (event) => {
    if (event.isTrusted) value = comment.value;
    else comment.value = value;
  });
  return () => value.trim();
}
