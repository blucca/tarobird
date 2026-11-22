/** While a pane or a queued message is dragged, text cannot be selected anywhere (a captured drag may
 * cross the sidebar). The mark is on the root element, set by the drag itself. A `body:has(…) *` rule
 * did the same job, but with it every DOM change anywhere restyled the whole page, drag or no drag. */
export function dragSelectLock(owner: "adhd" | "queue", on: boolean): void {
  const root = document.documentElement, key = owner === "adhd" ? "dragLockAdhd" : "dragLockQueue";
  if (on) root.dataset[key] = "true"; else delete root.dataset[key];
}
