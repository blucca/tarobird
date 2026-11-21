import type { MouseEvent } from "react";

// Where the third press of a click run began, per message surface.
const presses = new WeakMap<Element, { x: number; y: number }>();

/** Remember where a triple press starts, so a triple-click drag stays native. */
export function noteMessagePress(event: MouseEvent<HTMLDivElement>) {
  if (event.button === 0 && event.detail >= 3) presses.set(event.currentTarget, { x: event.clientX, y: event.clientY });
  else presses.delete(event.currentTarget);
}

/** A triple-click selects one visible message surface, never its virtual row or
 * the page. Single and double clicks keep the browser's caret and word
 * selection, as in the composer. The click count comes from the browser, not a
 * timer. Keep native word/line/drag selection in code, editing fields and phone
 * hold menus. React portal events still bubble here, so DOM containment is essential. */
export function selectMessageBubble(event: MouseEvent<HTMLDivElement>) {
  const root = event.currentTarget, target = event.target, press = presses.get(root);
  presses.delete(root);
  if (event.detail < 3 || event.defaultPrevented || event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey
    || !(target instanceof Element) || !root.contains(target)
    || root.closest("[data-hold-root],[inert],.is-selecting")) return;
  // A press that moved is a triple-click drag: keep the browser's paragraph extension.
  if (!press || Math.abs(event.clientX - press.x) > 4 || Math.abs(event.clientY - press.y) > 4) return;
  if (target.closest("button,a,input,textarea,select,label,summary,audio,video,pre,code,[role=button],[role=textbox],[contenteditable]:not([contenteditable=false]),.message-reference,.native-question")) return;

  // A native answer owns its prose, while its progress/footer controls are
  // separate. A legacy card owns just that card even in a multi-card message.
  const surface = target.closest<HTMLElement>(".native-run-prose,.rich-card")
    ?? (root.closest(".message.user") && (target === root || target.closest(".markdown")) ? root : undefined);
  if (!surface || !root.contains(surface) || !surface.querySelector(".markdown")) return;
  const selection = root.ownerDocument.getSelection();
  if (!selection) return;
  const range = root.ownerDocument.createRange();
  range.selectNodeContents(surface);
  selection.removeAllRanges();
  selection.addRange(range);
}
