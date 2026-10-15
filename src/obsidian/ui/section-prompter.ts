// The section actions' dialogs and notices in Obsidian (LFCP-03-008): the
// SectionPrompter port of core/sections/action-ports.ts over the existing
// section modals. Each dialog opens when it is asked for; the executor
// awaits its result and may bring it forward on a repeated start.

import { type App, type Modal, Notice } from "obsidian";
import type {
  CardAction,
  CardHandle,
  CardRowActions,
  DestinationChoice,
  InsertDestination,
  InsertPlace,
  LostBase,
  NoticeAction,
  RepairActions,
  ReviewResult,
  SectionChoice,
  SectionDialog,
  SectionPrompter,
} from "../../core/sections/action-ports";
import type { InsertPreview } from "../../core/sections/insert";
import type { ImportChoices, LegacyPreview } from "../../core/sections/legacy";
import type { RecoveryChoice, RecoveryItem } from "../../core/sections/recovery";
import type { RepairItem } from "../../core/sections/repair";
import type { SharePolicy, SharePreview } from "../../core/sections/share";
import type { SectionCard } from "../../core/status/card";
import { returnsFocus } from "./focus-return";
import { ImportSectionModal } from "./import-section";
import { ChooseDestinationModal, InsertSectionModal, PickSectionModal } from "./insert-section";
import { RecoveryModal } from "./recovery";
import { RepairModal } from "./repair";
import { AliasModal, ConfirmModal, SectionCardModal } from "./section-card";
import { ShareSectionModal } from "./share-section";

export class ObsidianSectionPrompter implements SectionPrompter {
  constructor(
    private readonly app: App,
    /** Says a short text once through the plugin's live region (064). */
    private readonly say: (text: string) => void,
    /** The settings a share runs under now: its preview says them (LFCP-03-014). */
    private readonly policy?: () => SharePolicy,
  ) {}

  notice(message: string, action?: NoticeAction): void {
    if (action === undefined) {
      new Notice(message);
      return;
    }
    // A result with its next step ("Open"): shown longer, the button closes it.
    const notice = new Notice(message, 10_000);
    const el = (notice as { messageEl?: HTMLElement }).messageEl;
    if (el === undefined) return;
    const button = el.createEl("button", { text: action.label, cls: "openlfcp-notice-action" });
    button.addEventListener("click", (e) => {
      e.stopPropagation();
      notice.hide();
      action.run();
    });
  }

  announce(text: string): void {
    this.say(text);
  }

  sharePreview(preview: SharePreview, note?: string): SectionDialog<boolean> {
    return opened(new ShareSectionModal(this.app, preview, note, this.policy?.()));
  }

  importPreview(title: string, preview: LegacyPreview): SectionDialog<ImportChoices | null> {
    return opened(new ImportSectionModal(this.app, title, preview));
  }

  pickSection(choices: readonly SectionChoice[]): SectionDialog<SectionChoice | null> {
    return opened(new PickSectionModal(this.app, choices));
  }

  insertPreview(preview: InsertPreview, place?: InsertPlace): SectionDialog<boolean> {
    return opened(new InsertSectionModal(this.app, preview, place));
  }

  chooseDestination(choice: DestinationChoice): SectionDialog<InsertDestination | null> {
    return opened(new ChooseDestinationModal(this.app, choice));
  }

  confirm(o: {
    readonly title: string;
    readonly message: string;
    readonly action: string;
    readonly destructive?: boolean;
  }): SectionDialog<boolean> {
    return opened(new ConfirmModal(this.app, o.title, o.message, o.action, o.destructive ?? true));
  }

  alias(current: string): Promise<string | null> {
    const ask = returnsFocus(new AliasModal(this.app, current));
    ask.open();
    return ask.result;
  }

  repair(
    items: readonly RepairItem[],
    lost: readonly LostBase[],
    actions: RepairActions,
  ): SectionDialog<void> {
    return opened(new RepairModal(this.app, items, lost, actions));
  }

  review(
    title: string,
    items: readonly RecoveryItem[],
    apply: (item: RecoveryItem, choice: RecoveryChoice) => Promise<ReviewResult>,
  ): void {
    returnsFocus(new RecoveryModal(this.app, title, items, apply)).open();
  }

  card(
    content: SectionCard,
    actions: readonly CardAction[],
    onClosed: () => void,
    rows: CardRowActions,
  ): CardHandle {
    // The card gives focus back itself (to its badge); this keeps Tab in it.
    const modal = returnsFocus(new SectionCardModal(this.app, content, actions, onClosed, rows));
    modal.open();
    return modal;
  }
}

/** A dialog opened now: its result, and bringing it forward. */
function opened<T>(modal: Modal & { readonly result: Promise<T> }): SectionDialog<T> {
  // U03-18: closed, it gives focus back to the pane or card control that opened it.
  returnsFocus(modal).open();
  return { result: modal.result, bringForward: () => bringForward(modal) };
}

/**
 * An open dialog brought in front of any other and focused (a repeated
 * start of its flow). The dialog itself takes the focus, never its Share
 * or Insert button: a repeated hotkey followed by Enter must not confirm.
 */
export function bringForward(modal: Modal): void {
  const box = (modal as { containerEl?: HTMLElement }).containerEl;
  box?.parentElement?.appendChild(box);
  const el = modal.modalEl;
  // Focusable without entering the Tab order (the test mock's elements have no attributes).
  if (typeof el.setAttribute === "function" && !el.hasAttribute("tabindex"))
    el.setAttribute("tabindex", "-1");
  el.focus?.();
}
