// The device dialogs (LFCP-04-413, draft §9 O2 + O3): "Add my other
// device…", "Your devices…", "Remove device…" and "Pair this device with a
// link…", over the Obsidian-free DeviceService. Plain Obsidian modals; the
// words are pairing-view.ts's.
//
// Secrets: the pairing link is shown only on "Show link" and copied on
// "Copy link", as an invitation is; the link field of the new device is a
// password input. Nothing here logs.
//
// A dialog closed half way loses nothing: a link stays usable until it is
// cancelled or used, a request until it is answered, and the commands show
// them again (the SDK's journal, §9).

import type { MaskPreset, PairingLinkText, PairingReview } from "@openlfcp/client";
import { fromHex, type ResourceId } from "@openlfcp/core";
import { type App, Modal, Notice } from "obsidian";
import { type DeviceRow, deviceLine } from "../../core/identity/device-list";
import { pollDelay } from "../../core/identity/pacing";
import {
  type ApprovalView,
  KEEP_COPY,
  LINK_HELP,
  NO_DEVICES,
  PAIR_HELP,
  reviewView,
  severalRequests,
  unfinishedText,
  WAITING_FOR_DEVICE,
} from "../../core/identity/pairing-view";
import type { DeviceService, Unfinished } from "../../core/identity/service";
import { returnsFocus } from "./focus-return";

const clipboard = async (text: string): Promise<void> => {
  const board = (window.navigator as { clipboard?: Clipboard } | undefined)?.clipboard;
  if (board === undefined) throw new Error("no clipboard");
  await board.writeText(text);
};

const buttonRow = (el: HTMLElement): HTMLElement => el.createDiv({ cls: "modal-button-container" });

/**
 * Asks the server again while its dialog is open (one per dialog), with the
 * backoff of pacing.ts: 4 s, 8 s, 15 s, then every 30 s; from the start
 * again when the person acts in the dialog (reset).
 */
class Poller {
  #timer: number | null = null;
  #closed = false;
  #busy = false;
  #step: (() => Promise<boolean>) | null = null;
  /** Questions asked since the last start or user action. */
  #asked = 0;

  /** The dialog was closed: nothing more is asked or drawn. */
  get closed(): boolean {
    return this.#closed;
  }

  /** Runs `step` now and then, with the backoff, until it returns false or the dialog closes. */
  run(step: () => Promise<boolean>): void {
    this.stop();
    this.#step = step;
    this.#asked = 0;
    void this.#go();
  }

  /** The person acted (Check now, the link copied or shown): ask now, and from 4 s again. */
  reset(): void {
    if (this.#closed || this.#step === null) return;
    this.stop();
    this.#asked = 0;
    void this.#go();
  }

  async #go(): Promise<void> {
    const step = this.#step;
    if (this.#closed || this.#busy || step === null) return;
    this.#busy = true;
    let again = false;
    try {
      again = await step();
    } catch (e) {
      // An error no result kind describes: said once, and no more asking.
      new Notice(`Shared Tasks: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.#busy = false;
    }
    if (!again) this.#step = null;
    else if (!this.#closed) {
      const wait = pollDelay(this.#asked++);
      this.#timer = window.setTimeout(() => void this.#go(), wait);
    }
  }

  stop(): void {
    if (this.#timer !== null) window.clearTimeout(this.#timer);
    this.#timer = null;
  }

  close(): void {
    this.#closed = true;
    this.stop();
  }
}

/** "Add my other device…": the link, then each request to approve or reject (§5.3 steps 1, 4–10). */
export class AddDeviceModal extends Modal {
  readonly #poller = new Poller();

  get closed(): boolean {
    return this.#poller.closed;
  }

  override onClose(): void {
    this.#poller.close();
    this.contentEl.empty();
  }

  #session: string | null = null;
  #link: PairingLinkText | null = null;
  #status: HTMLElement | null = null;

  constructor(
    app: App,
    private readonly service: DeviceService,
    private readonly label: string,
    private readonly copy: (text: string) => Promise<void> = clipboard,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.setTitle("Add my other device");
    this.contentEl.createEl("p", { text: "Making a link…" });
    void this.#start();
  }

  async #start(): Promise<void> {
    const view = await this.service.startSession(this.label);
    if (this.closed) return;
    if (view.kind === "stop" || view.result.kind !== "created") {
      this.#message(view.kind === "stop" ? view.message : "No link was made.");
      return;
    }
    this.#session = view.session;
    this.#link = view.result.link;
    this.#showLink();
  }

  #message(text: string, actions: readonly [string, () => void][] = []): void {
    const el = this.contentEl;
    el.empty();
    el.createEl("p", { text });
    const buttons = buttonRow(el);
    for (const [label, run] of actions)
      buttons.createEl("button", { text: label, cls: "mod-cta" }).addEventListener("click", run);
    buttons.createEl("button", { text: "Close" }).addEventListener("click", () => this.close());
  }

  #showLink(): void {
    const el = this.contentEl;
    const link = this.#link;
    if (link === null) return;
    el.empty();
    el.createEl("p", { text: LINK_HELP });
    el.createEl("p", {
      text: "It adds one device, and only once you approve it here. It is a secret: send it only to yourself.",
    });
    const shown = el.createEl("input", { type: "password", value: "" });
    shown.readOnly = true;
    shown.hidden = true;
    const buttons = buttonRow(el);
    buttons
      .createEl("button", { text: "Copy link", cls: "mod-cta" })
      .addEventListener("click", () => {
        this.#poller.reset();
        void this.copy(link.reveal()).then(
          () => new Notice("Shared Tasks: link copied."),
          () => new Notice("Shared Tasks: could not copy; show the link and copy it from there."),
        );
      });
    buttons.createEl("button", { text: "Show link" }).addEventListener("click", () => {
      this.#poller.reset();
      shown.type = "text";
      shown.value = link.reveal();
      shown.hidden = false;
      shown.select();
    });
    buttons.createEl("button", { text: "Cancel link" }).addEventListener("click", () => {
      void this.#cancel();
    });
    buttons
      .createEl("button", { text: "Check now" })
      .addEventListener("click", () => this.#poller.reset());
    this.#status = el.createEl("p", {
      cls: "setting-item-description",
      text: WAITING_FOR_DEVICE,
    });
    this.#poller.run(() => this.#check());
  }

  async #check(): Promise<boolean> {
    const session = this.#session;
    if (session === null) return false;
    const reviews = await this.service.requests(session);
    if (this.closed) return false;
    if (reviews === null) {
      this.#status?.setText("The server could not be reached. Retrying…");
      return true;
    }
    if ("kind" in reviews) {
      this.#message(reviews.message);
      return false;
    }
    const first = reviews[0];
    if (first === undefined) return true;
    if (reviews.length === 1) await this.#review(first, null);
    else this.#requests(reviews);
    return false;
  }

  /** More than one installation used the link (§5.3 "Concurrency"; e2e 13): each, by fingerprint. */
  #requests(reviews: readonly PairingReview[]): void {
    const el = this.contentEl;
    el.empty();
    el.createEl("p", { text: severalRequests(reviews.length) });
    for (const r of reviews) {
      const item = el.createDiv({ cls: "setting-item" });
      const info = item.createDiv({ cls: "setting-item-info" });
      info.createDiv({ cls: "setting-item-name", text: r.label });
      info.createDiv({ cls: "setting-item-description", text: `Fingerprint ${r.fingerprint}` });
      item
        .createDiv({ cls: "setting-item-control" })
        .createEl("button", { text: "Review" })
        .addEventListener("click", () => void this.#review(r, null));
    }
    const buttons = buttonRow(el);
    buttons
      .createEl("button", { text: "Cancel link", cls: "mod-warning" })
      .addEventListener("click", () => {
        void this.#cancel();
      });
  }

  async #review(review: PairingReview, note: string | null): Promise<void> {
    const names = await this.service.names();
    if (this.closed) return;
    const view = reviewView(review, names);
    const el = this.contentEl;
    el.empty();
    this.setTitle(view.title);
    if (note !== null) el.createEl("p", { text: note });
    for (const line of view.details) el.createEl("p", { text: line });
    el.createEl("p", { text: "Fingerprint of the new device:" });
    el.createEl("h3").createEl("code", { text: view.fingerprint });
    el.createEl("p", {
      text: "Check that the other device shows the same fingerprint. If it does not, reject: someone else has the link.",
    });
    const select = el.createEl("select", { cls: "dropdown" });
    for (const p of view.presets) {
      const option = select.createEl("option", {
        text: p.offered ? p.label : `${p.label} (not available: ${p.reason ?? "not allowed"})`,
        value: p.preset,
      });
      option.disabled = !p.offered;
    }
    select.value = view.preset;
    const scope = new Map<string, HTMLInputElement>();
    if (view.scope.length > 0) {
      el.createEl("p", { text: "Sections it may use (you may remove some, not add):" });
      for (const s of view.scope) {
        const label = el.createEl("label");
        const box = label.createEl("input", { type: "checkbox" });
        box.checked = true;
        label.createSpan({ text: ` ${s.name}` });
        el.createEl("br");
        scope.set(s.resource, box);
      }
    }
    const confirm = el.createEl("label");
    const match = confirm.createEl("input", { type: "checkbox" });
    confirm.createSpan({ text: " The fingerprints match" });
    const buttons = buttonRow(el);
    const approve = buttons.createEl("button", { text: "Approve", cls: "mod-cta" });
    approve.disabled = true;
    match.addEventListener("change", () => {
      approve.disabled = !match.checked;
    });
    approve.addEventListener("click", () => {
      const chosen = [...scope].filter(([, b]) => b.checked).map(([r]) => fromHex(r) as ResourceId);
      if (scope.size > 0 && chosen.length === 0) {
        new Notice("Shared Tasks: keep at least one section, or reject the request.");
        return;
      }
      approve.disabled = true;
      void this.#approve(review, select.value as MaskPreset, scope.size > 0 ? chosen : undefined);
    });
    buttons
      .createEl("button", { text: "Reject", cls: "mod-warning" })
      .addEventListener("click", () => {
        void this.#cancel(review.requestKey);
      });
  }

  async #approve(
    review: PairingReview,
    preset: MaskPreset,
    scope: readonly ResourceId[] | undefined,
  ): Promise<void> {
    this.#message(`Adding "${review.label}"…`);
    this.#showApproval(await this.service.approve(review, preset, scope), review.label);
  }

  #showApproval(view: ApprovalView, label: string): void {
    if (this.closed) return;
    switch (view.kind) {
      case "done":
      case "stop":
        this.#message(view.message);
        return;
      case "finish":
        this.#message(view.message, [
          [
            "Finish",
            () => {
              this.#message(`Finishing "${label}"…`);
              void this.service
                .finishApproval(view.operation, label)
                .then((v) => this.#showApproval(v, label));
            },
          ],
        ]);
        return;
      case "reconfirm":
        if (view.review === undefined) this.#message(view.message);
        else void this.#review(view.review, view.message);
        return;
    }
  }

  async #cancel(reject?: string): Promise<void> {
    const session = this.#session;
    if (session === null) return;
    this.#poller.stop();
    this.#message(reject === undefined ? "Cancelling the link…" : "Rejecting…");
    const view = await this.service.cancel(session, reject);
    if (this.closed) return;
    this.#message(
      view.message,
      view.kind === "retry" ? [["Try again", () => void this.#cancel(reject)]] : [],
    );
  }
}

/** "Remove device…": the preview, the reason, then the result (§8). */
class RemoveDeviceModal extends Modal {
  constructor(
    app: App,
    private readonly service: DeviceService,
    private readonly row: DeviceRow,
    private readonly done: () => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.setTitle(`Remove "${this.row.label}"`);
    this.contentEl.createEl("p", { text: "Checking what it affects…" });
    void this.#preview();
  }

  async #preview(): Promise<void> {
    const preview = await this.service.previewRemoval(this.row.principal);
    const el = this.contentEl;
    el.empty();
    if ("kind" in preview || preview.blocked !== null) {
      el.createEl("p", { text: "kind" in preview ? preview.message : (preview.blocked ?? "") });
      buttonRow(el)
        .createEl("button", { text: "Close" })
        .addEventListener("click", () => this.close());
      return;
    }
    for (const line of preview.lines) el.createEl("p", { text: line });
    el.createEl("p", { text: "Why?" });
    const reason = el.createEl("select", { cls: "dropdown" });
    reason.createEl("option", { text: "I no longer use it", value: "0" });
    reason.createEl("option", { text: "It is lost", value: "1" });
    reason.createEl("option", { text: "Someone else may have it (stolen or hacked)", value: "2" });
    if (this.row.thisDevice) reason.value = "0";
    const buttons = buttonRow(el);
    if (preview.suspended.length > 0)
      buttons
        .createEl("button", { text: "Re-certify them first" })
        .addEventListener("click", () => {
          el.empty();
          el.createEl("p", { text: "Re-certifying…" });
          void this.service.recertify(preview.suspended).then((text) => {
            new Notice(`Shared Tasks: ${text}`);
            void this.#preview();
          });
        });
    buttons
      .createEl("button", { text: "Remove device", cls: "mod-warning" })
      .addEventListener("click", () => {
        const r = reason.value === "2" ? 2n : reason.value === "1" ? 1n : 0n;
        void this.#remove(r);
      });
    const cancel = buttons.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.close());
    cancel.focus();
  }

  async #remove(reason: 0n | 1n | 2n, operation?: string): Promise<void> {
    const el = this.contentEl;
    el.empty();
    el.createEl("p", { text: "Removing…" });
    const view = await this.service.remove(this.row.principal, reason, this.row.label, operation);
    el.empty();
    el.createEl("p", { text: view.message });
    const buttons = buttonRow(el);
    if (view.kind === "retry")
      buttons
        .createEl("button", { text: "Try again", cls: "mod-cta" })
        .addEventListener("click", () => {
          void this.#remove(reason, view.operation);
        });
    buttons.createEl("button", { text: "Close" }).addEventListener("click", () => this.close());
    this.done();
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

/** "Your devices…": the list, unfinished steps, and the actions each device allows. */
export class DevicesModal extends Modal {
  constructor(
    app: App,
    private readonly service: DeviceService,
    private readonly addDevice: () => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.setTitle("Your devices");
    this.contentEl.createEl("p", { text: "Loading…" });
    // The list as stored, then what the upkeep finishes now (§7.1, §8.4), then the list again.
    void this.#render().then(() => this.#finish(false));
  }

  /** Runs the device upkeep (forced from "Finish now"), then shows the list again. */
  async #finish(say: boolean): Promise<void> {
    try {
      const r = await this.service.upkeep(true);
      if (say) new Notice(`Shared Tasks: ${r.summary}`);
    } catch (e) {
      if (say) new Notice(`Shared Tasks: ${e instanceof Error ? e.message : String(e)}`);
    }
    await this.#render();
  }

  async #render(): Promise<void> {
    const el = this.contentEl;
    let read: [
      Awaited<ReturnType<DeviceService["devices"]>>,
      readonly Unfinished[],
      Awaited<ReturnType<DeviceService["accessStates"]>>,
    ];
    try {
      read = await Promise.all([
        this.service.devices(),
        this.service.unfinished(),
        this.service.accessStates(),
      ]);
    } catch (e) {
      el.empty();
      el.createEl("p", {
        text: `Your devices could not be read: ${e instanceof Error ? e.message : String(e)}`,
      });
      return;
    }
    const [list, unfinished, access] = read;
    el.empty();
    if (list.kind === "none") {
      el.createEl("p", { text: NO_DEVICES });
    } else {
      if (list.note !== null)
        el.createEl("p", { text: list.note, cls: "setting-item-description" });
      for (const row of list.rows) this.#row(el, row, list.manages);
    }
    for (const u of unfinished) this.#unfinished(el, u);
    if (access.length > 0) {
      el.createEl("h4", { text: "Sections this device no longer syncs" });
      for (const a of access) el.createEl("p", { text: `"${a.name}": ${a.text}` });
      el.createEl("p", {
        cls: "setting-item-description",
        text: KEEP_COPY,
      });
    }
    const buttons = buttonRow(el);
    if (list.kind === "none" || list.manages)
      buttons
        .createEl("button", { text: "Add my other device…", cls: "mod-cta" })
        .addEventListener("click", () => {
          this.close();
          this.addDevice();
        });
    buttons.createEl("button", { text: "Close" }).addEventListener("click", () => this.close());
  }

  #row(el: HTMLElement, row: DeviceRow, manages: boolean): void {
    const item = el.createDiv({ cls: "setting-item" });
    const info = item.createDiv({ cls: "setting-item-info" });
    info.createDiv({ cls: "setting-item-name", text: deviceLine(row) });
    info.createDiv({
      cls: "setting-item-description",
      text: `Fingerprint ${row.fingerprint}${row.state === "suspended" ? ". It stopped because a device that added it was removed." : ""}`,
    });
    const control = item.createDiv({ cls: "setting-item-control" });
    if (!manages || row.first || row.state === "removed") return;
    if (row.state === "suspended" && !row.thisDevice)
      control.createEl("button", { text: "Re-certify" }).addEventListener("click", () => {
        void this.service.recertify([row.principal]).then((text) => {
          new Notice(`Shared Tasks: ${text}`);
          void this.#render();
        });
      });
    control
      .createEl("button", { text: "Remove device…", cls: "mod-warning" })
      .addEventListener("click", () => {
        const remove = new RemoveDeviceModal(
          this.app,
          this.service,
          row,
          () => void this.#render(),
        );
        returnsFocus(remove).open();
      });
  }

  #unfinished(el: HTMLElement, u: Unfinished): void {
    if (u.kind === "request") return;
    if (
      u.kind === "registration" ||
      u.kind === "key" ||
      u.kind === "handover" ||
      u.kind === "roster"
    ) {
      const item = el.createDiv({ cls: "setting-item" });
      item.createDiv({
        cls: "setting-item-info",
        text: unfinishedText({ kind: u.kind, label: u.label, sections: u.sections ?? [] }),
      });
      const button = item
        .createDiv({ cls: "setting-item-control" })
        .createEl("button", { text: "Finish now", cls: "mod-cta" });
      button.addEventListener("click", () => {
        button.disabled = true;
        void this.#finish(true);
      });
      return;
    }
    const item = el.createDiv({ cls: "setting-item" });
    item.createDiv({
      cls: "setting-item-info",
      text:
        u.kind === "approval"
          ? `Adding "${u.label}" is not finished.`
          : `Removing "${u.label}" is not finished.`,
    });
    const button = item
      .createDiv({ cls: "setting-item-control" })
      .createEl("button", { text: u.kind === "approval" ? "Finish" : "Try again", cls: "mod-cta" });
    button.addEventListener("click", () => {
      button.disabled = true;
      const run =
        u.kind === "approval"
          ? this.service.finishApproval(u.operation, u.label)
          : this.service.resumeRemoval(u.operation);
      void run.then((view) => {
        new Notice(`Shared Tasks: ${view.message}`);
        void this.#render();
      });
    });
  }
}

/** "Pair this device with a link…": the request, the fingerprint, then the result (§5.3 steps 2–3, 8, 11). */
export class PairThisDeviceModal extends Modal {
  readonly #poller = new Poller();

  get closed(): boolean {
    return this.#poller.closed;
  }

  override onClose(): void {
    this.#poller.close();
    this.contentEl.empty();
  }

  constructor(
    app: App,
    private readonly service: DeviceService,
    private readonly label: string,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.setTitle("Pair this device");
    void this.#start();
  }

  async #start(): Promise<void> {
    const open = await this.service.openRequest();
    if (this.closed) return;
    if (open !== null) {
      this.#waiting(open.operation, open.fingerprint);
      return;
    }
    const refusal = await this.service.pairRefusal();
    if (this.closed) return;
    if (refusal !== null) {
      this.#message(refusal);
      return;
    }
    this.#form();
  }

  #message(text: string): void {
    const el = this.contentEl;
    el.empty();
    el.createEl("p", { text });
    buttonRow(el)
      .createEl("button", { text: "Close" })
      .addEventListener("click", () => this.close());
  }

  #form(): void {
    const el = this.contentEl;
    el.empty();
    el.createEl("p", { text: PAIR_HELP });
    const link = el.createEl("input", { type: "password", placeholder: "lfcp://pair/…" });
    el.createEl("p", { text: "Name of this device:" });
    const name = el.createEl("input", { type: "text", value: this.label });
    const buttons = buttonRow(el);
    const send = buttons.createEl("button", { text: "Pair", cls: "mod-cta" });
    send.addEventListener("click", () => {
      const text = link.value.trim();
      const label = name.value.trim() || this.label;
      link.value = "";
      if (!/^lfcp:\/\/pair\//i.test(text)) {
        new Notice(
          "Shared Tasks: paste the link your other device shows (it starts with lfcp://pair/).",
        );
        return;
      }
      send.disabled = true;
      void this.#request(text, label);
    });
    buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    link.focus();
  }

  async #request(link: string, label: string): Promise<void> {
    const el = this.contentEl;
    el.empty();
    el.createEl("p", { text: "Sending the request…" });
    const view = await this.service.request(link, label);
    if (this.closed) return;
    if (view.kind === "stop") this.#message(view.message);
    else this.#waiting(view.operation, view.fingerprint);
  }

  #waiting(operation: string, fingerprint: string): void {
    const el = this.contentEl;
    el.empty();
    el.createEl("p", { text: "Fingerprint of this device:" });
    el.createEl("h3").createEl("code", { text: fingerprint });
    el.createEl("p", {
      text: "Check that your other device shows the same fingerprint, then approve it there. Closing this keeps the request; open this again to see its result.",
    });
    const headline = el.createEl("p", { text: "Waiting for your other device to approve…" });
    const sections = el.createEl("ul");
    const buttons = buttonRow(el);
    buttons
      .createEl("button", { text: "Check now" })
      .addEventListener("click", () => this.#poller.reset());
    buttons.createEl("button", { text: "Close" }).addEventListener("click", () => this.close());
    this.#poller.run(async () => {
      const view = await this.service.progress(operation);
      if (this.closed) return false;
      headline.setText(view.headline);
      sections.empty();
      if (view.deviceList !== null)
        sections.createEl("li", { text: `Your device list: ${view.deviceList}` });
      for (const s of view.sections) sections.createEl("li", { text: `${s.name}: ${s.status}` });
      for (const name of view.opened) new Notice(`Shared Tasks: "${name}" is on this device now.`);
      // Final, or waiting for an update of the plugin: no more asking now.
      return !(view.final || view.paused);
    });
  }
}
