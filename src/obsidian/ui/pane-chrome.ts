// The Obsidian side of the pane's header (UXD-11): icons, tooltips and the
// "More actions" menu, handed to the renderer as its `chrome` so the renderer
// itself imports nothing from `obsidian`.
//
// The menu is Obsidian's own `Menu`: it lives outside the pane's DOM, so a
// redraw of the pane never closes it under the user. A destructive item is
// marked as a warning; a blocked one stays in the list, disabled, with its
// reason after its title (A5). Choosing an item runs the action the way the
// pane's own buttons do: `run` is the view's click path, which checks the
// facts again at the click (L2).

import { Menu, setIcon, setTooltip } from "obsidian";
import type { ActionId } from "../../core/actions/catalog";
import { ACTION_ICONS } from "../../core/pane/icons";
import type { PaneChrome } from "./pane-renderer";

export function obsidianChrome(run: (id: ActionId) => void): PaneChrome {
  return {
    icon: (el, name) => setIcon(el, name),
    tooltip: (el, text) => setTooltip(el, text),
    menu: (anchor, items) => {
      const menu = new Menu();
      for (const a of items)
        menu.addItem((item) => {
          item.setTitle(a.reason === null || a.enabled ? a.label : `${a.label} — ${a.reason}`);
          item.setIcon(ACTION_ICONS[a.id]);
          if (a.destructive) item.setWarning(true);
          if (a.enabled) item.onClick(() => run(a.id));
          else item.setDisabled(true);
        });
      // Under the button, from its left edge; Obsidian keeps the menu inside the window.
      const at = anchor.getBoundingClientRect();
      menu.showAtPosition({ x: at.left, y: at.bottom }, anchor.ownerDocument);
    },
  };
}
