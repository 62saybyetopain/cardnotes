export function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable === true;
}

export function isRemoveKey(e: { key: string }): boolean {
  return e.key === "Delete" || e.key === "Backspace";
}
