// Copy paths of shared sections in Obsidian (LFCP-02-063, UX §8,
// OBSIDIAN-SYNC-INDICATORS-01 §9).
//
// - Editors: CodeMirror copies the document's text, so the badge and row
//   cues (widgets, never text) are not in it, and bindings in the selection
//   stay as source.
// - Reading view: a selection copies DOM, badges included. The copy filter
//   takes the selection without the plugin's own nodes ([data-lfcp-ui]) for
//   both text/html and text/plain: CSS exclusion alone does not keep them
//   out of the clipboard.
// - "Copy readable text" and "Copy shared section": the core's text, as
//   plain text.

/**
 * A copy in rendered content: when the selection holds plugin UI, the
 * clipboard gets it without that UI. Returns whether it handled the event.
 */
export function filterUiFromCopy(e: ClipboardEvent, doc: Document): boolean {
  const sel = doc.getSelection();
  if (sel === null || sel.rangeCount === 0 || e.clipboardData === null) return false;
  const range = sel.getRangeAt(0);
  // Editors handle their own copy (document text): only rendered content here.
  const host = range.commonAncestorContainer;
  const el = host instanceof Element ? host : host.parentElement;
  if (el === null || el.closest(".cm-editor") !== null) return false;
  const fragment = range.cloneContents();
  const ui = fragment.querySelectorAll("[data-lfcp-ui]");
  if (ui.length === 0) return false;
  for (const n of Array.from(ui)) n.remove();
  const box = doc.createElement("div");
  box.appendChild(fragment);
  e.clipboardData.setData("text/html", box.innerHTML);
  e.clipboardData.setData("text/plain", box.textContent ?? "");
  e.preventDefault();
  return true;
}
