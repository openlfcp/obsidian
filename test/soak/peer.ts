// One soak peer (LFCP-02 soak of 0.4.0-beta.17): the real plugin on a mock
// Obsidian app (E2EVault), on a local reference server, driven as a person
// would through its commands, dialogs and vault edits. Its own process, so
// its memory is its own; the controller (soak.mjs) drives it over a line
// protocol (peer.soak.test.ts).

import { EditorSelection, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { fromBase64url, type ResourceId, toBase64url, toHex } from "@openlfcp/core";
import { SdkSectionPort } from "../../src/core/lfcp/section-port";
import { markdownState } from "../../src/core/sections/base";
import { SectionEngine } from "../../src/core/sections/engine";
import { parseSections } from "../../src/core/sections/parser";
import * as mock from "../mocks/obsidian";
import { E2EVault, until } from "../support/e2e-vault";
// After e2e-vault (it installs fake-indexeddb): finished transactions are dropped.
import "../support/idb-prune";

// Nothing leaves this machine: every socket goes to the local server.
{
  const g = globalThis as unknown as { WebSocket: new (u: string, p?: string[]) => unknown };
  const Native = g.WebSocket;
  g.WebSocket = class extends (Native as new (u: string, p?: string[]) => object) {
    constructor(url: string, protocols?: string[]) {
      if (!/^ws:\/\/127\.0\.0\.1:\d+\//.test(String(url)))
        throw new Error(`soak: refusing a socket to ${String(url)}`);
      super(url, protocols);
    }
  } as never;
}

// Obsidian's DOM helpers, as far as the plugin's headless paths use them (happy-dom has none).
{
  type El = HTMLElement & Record<string, unknown>;
  const P = HTMLElement.prototype as unknown as Record<string, unknown>;
  P.createEl ??= function (
    this: El,
    tag: string,
    o: { cls?: string | string[]; text?: string; attr?: Record<string, unknown> } = {},
  ) {
    const el = (this.ownerDocument as Document).createElement(tag);
    if (o.cls !== undefined) el.className = Array.isArray(o.cls) ? o.cls.join(" ") : o.cls;
    if (o.text !== undefined) el.textContent = o.text;
    for (const [k, v] of Object.entries(o.attr ?? {})) el.setAttribute(k, String(v));
    this.appendChild(el);
    return el;
  };
  P.createDiv ??= function (this: El, o?: unknown) {
    return (this.createEl as (t: string, o?: unknown) => HTMLElement)("div", o);
  };
  P.createSpan ??= function (this: El, o?: unknown) {
    return (this.createEl as (t: string, o?: unknown) => HTMLElement)("span", o);
  };
  P.empty ??= function (this: El) {
    this.replaceChildren();
  };
  P.setText ??= function (this: El, t: string) {
    this.textContent = t;
  };
  P.addClass ??= function (this: El, ...c: string[]) {
    this.classList.add(...c);
  };
  P.removeClass ??= function (this: El, ...c: string[]) {
    this.classList.remove(...c);
  };
  P.toggleClass ??= function (this: El, c: string, on: boolean) {
    this.classList.toggle(c, on);
  };
  P.setAttr ??= function (this: El, k: string, v: unknown) {
    this.setAttribute(k, String(v));
  };
  // Obsidian's document of the active window.
  (globalThis as { activeDocument?: Document }).activeDocument ??= document;
}

// What the mock Obsidian lacks for the sections host (its tests run with sections off).
{
  const P = mock.Plugin.prototype as unknown as Record<string, unknown>;
  P.register ??= function (this: { unloads?: (() => void)[] }, fn: () => void) {
    if (this.unloads === undefined) this.unloads = [];
    this.unloads.push(fn);
  };
  P.registerInterval ??= (id: number) => id;
  P.registerMarkdownPostProcessor ??= () => undefined;
  const W = mock.Workspace.prototype as unknown as Record<string, unknown>;
  W.on ??= () => ({});
  W.onLayoutReady ??= (fn: () => void) => fn();
}

/** Each engine pass, timed (the plugin's own engine instance: no module reset here). */
const passTimes: number[] = [];
{
  const proto = SectionEngine.prototype as unknown as {
    pass: (...a: unknown[]) => Promise<unknown>;
  };
  const original = proto.pass;
  proto.pass = async function (this: unknown, ...a: unknown[]) {
    const t = performance.now();
    try {
      return await original.apply(this, a);
    } finally {
      passTimes.push(performance.now() - t);
    }
  };
}

export const SECTION_NOTE = "Soak.md";
export const LEGACY_NOTE = "Legacy.md";
const TASK = /^(\s*)- \[([ x])\] (.*)$/;
const WORDS = ["plan", "draft", "review", "ship", "call", "fix", "テスト", "仕事", "zakaz", "note"];

const lines = (md: string) => md.split("\n");
/** The indentation in columns (a tab is four, as in Obsidian). */
const indentOf = (l: string) =>
  [...(/^\s*/.exec(l)?.[0] ?? "")].reduce((n, c) => (c === "\t" ? n + 4 - (n % 4) : n + 1), 0);
const leading = (l: string) => /^\s*/.exec(l)?.[0] ?? "";

/** The lines [from, to) of the Task at `at`: its line, its binding and the more indented lines under it. */
function blockAt(L: readonly string[], at: number): [number, number] {
  const indent = indentOf(L[at] ?? "");
  let to = at + 1;
  while (to < L.length && /^\s+\S/.test(L[to] ?? "") && indentOf(L[to] ?? "") > indent) to++;
  return [at, to];
}

function random(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

function percentile(xs: readonly number[], p: number): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] as number;
}

/** Answers the newest open dialog: clicks its button, or picks a suggestion. */
export async function answer(
  what: string,
  act: (m: mock.Modal) => boolean,
  ms = 30_000,
): Promise<void> {
  await until(
    what,
    () => {
      const open = mock.modals.filter((m) => m.isOpen).at(-1);
      return open !== undefined && act(open) ? true : undefined;
    },
    ms,
  );
}
export const click = (text: string) => (m: mock.Modal) => {
  const b = m.contentEl.findAll("button").find((x) => x.text === text);
  if (b === undefined || (b as { disabled?: boolean }).disabled === true) return false;
  b.click();
  return true;
};

export class SoakPeer {
  readonly rnd: () => number;
  #next = 1;
  #lastInbound = 0;
  #R: ResourceId | null = null;
  #sid = "";
  readonly legacy: ResourceId[] = [];
  #legacyIds: string[] = [];

  private constructor(
    readonly name: string,
    readonly me: string,
    readonly vault: E2EVault,
    readonly server: string,
    seed: number,
  ) {
    this.rnd = random(seed);
    // The harness records every frame; the soak keeps only when the last one arrived.
    const frames = vault.network.frames as unknown as { push: (...f: { dir: string }[]) => number };
    frames.push = (...f) => {
      if (f.some((x) => x.dir === "in")) this.#lastInbound = Date.now();
      return 0;
    };
  }

  static async open(name: string, me: string, server: string, seed: number): Promise<SoakPeer> {
    if (!server.startsWith("ws://127.0.0.1:")) throw new Error(`not a local server: ${server}`);
    // The vault's data.json: sections on (the mock keeps them off without a
    // DOM; the peer has happy-dom), and never the project server.
    const proto = mock.Plugin.prototype as unknown as {
      loadData: (this: { stored: unknown }) => Promise<unknown>;
    };
    proto.loadData = async function () {
      return this.stored ?? { sectionsDisabled: false, defaultServer: server, settingsVersion: 2 };
    };
    // The plugin's own tick (the tests' 20 ms would tick 12.5 times as often).
    const vault = await E2EVault.open(name, { tickMs: 250 });
    if (vault.plugin.sections === null || vault.plugin.settings.defaultServer !== server)
      throw new Error(`${name}: sections off or another server`);
    const p = new SoakPeer(name, me, vault, server, seed);
    // Titles this peer creates continue after the ones it already owns.
    return p;
  }

  get runtime() {
    return this.vault.runtime;
  }

  #port() {
    const runtime = this.runtime;
    return new SdkSectionPort({
      profile: (r) => runtime.sectionProfile(r),
      commit: (r, intents, o) => runtime.commitSection(r, intents, o),
      storage: runtime.storage as never,
      canWrite: (r) => runtime.canWriteSection(r),
    });
  }

  get resource(): string {
    if (this.#R === null) throw new Error(`${this.name}: no section yet`);
    return toBase64url(this.#R);
  }

  // ---- setup ----

  /** The owner writes the note and shares its section through "Share section…". */
  async share(
    tasks: number,
    owners: readonly string[],
  ): Promise<{ resource: string; sid: string }> {
    const body: string[] = ["# Soak", "", "Private intro, never shared.", "", "## Work", ""];
    for (let i = 0; i < tasks; i++) {
      const who = owners[i % owners.length] as string;
      const nested = i % 10 === 9;
      body.push(`${nested ? "    " : ""}- [ ] ${who}${i + 1} ${WORDS[i % WORDS.length]} item`);
    }
    body.push("", "A paragraph inside the section.", "", "## After", "Private tail.", "");
    for (const o of owners) if (o === this.me) this.#next = tasks + 1;
    const md = body.join("\n");
    await this.vault.write(SECTION_NOTE, md);
    const view = new mock.MarkdownView({ path: SECTION_NOTE } as never, md);
    view.cursorLine = 4;
    const sections = this.vault.plugin.sections;
    if (sections === null) throw new Error("no sections host");
    const notices = mock.notices.length;
    const done = sections.share(view.editor as never, SECTION_NOTE);
    await answer("the share preview", click("Share"));
    await done;
    await until(
      "the section shared",
      () => (/(is shared|could not|stopped)/.test(this.#noticesSince(notices)) ? true : undefined),
      60_000,
    );
    if (!this.#noticesSince(notices).includes("is shared"))
      throw new Error(`share: ${this.#noticesSince(notices)}`);
    await this.vault.settle();
    this.#bind();
    return { resource: this.resource, sid: this.#sid };
  }

  #noticesSince(n: number): string {
    return mock.notices.slice(n).join(" | ");
  }

  #bind(): void {
    const s = parseSections(this.vault.read(SECTION_NOTE)).sections[0];
    if (s === undefined) throw new Error(`${this.name}: no section in the note`);
    this.#R = s.ref.resourceId as ResourceId;
    this.#sid = s.ref.sectionId;
  }

  /** "Invite collaborator…" for a Resource (base64url); the one-time link. */
  async invite(resource: string): Promise<string> {
    const before = this.vault.prompter.invitations.length;
    await this.vault.action(
      "invite",
      { section: { key: resource, title: "" } },
      ["Read + write"],
      () => this.vault.prompter.invitations.length > before,
    );
    return this.vault.prompter.invitations.at(-1)?.reveal() as string;
  }

  async join(link: string, name: string): Promise<string> {
    return this.vault.action("join-with-link", {}, [link, name]);
  }

  /** "Insert shared section…" into this peer's own note. */
  async insert(resource: string): Promise<void> {
    const R = fromBase64url(resource) as ResourceId;
    await until(
      "the section loaded",
      () => (this.runtime.sectionLoad(R)?.loaded === true ? true : undefined),
      120_000,
    );
    const md = `# ${this.name}'s note\n\nMy own text.\n`;
    await this.vault.write(SECTION_NOTE, md);
    const view = new mock.MarkdownView({ path: SECTION_NOTE } as never, md);
    view.cursorLine = 2;
    const sections = this.vault.plugin.sections;
    if (sections === null) throw new Error("no sections host");
    // As a person does: "not fully arrived yet" means trying again in a moment.
    let done: Promise<void> | null = null;
    for (const deadline = Date.now() + 600_000; done === null; ) {
      const before = mock.notices.length;
      const attempt = sections.insertSection(view.editor as never, SECTION_NOTE);
      const picked = await until(
        "the section choice or a notice",
        () => {
          const open = mock.modals.filter((m) => m.isOpen).at(-1) as
            | (mock.Modal & {
                choices?: readonly { resource: Uint8Array }[];
                onChooseSuggestion?: (c: unknown) => void;
              })
            | undefined;
          const c = open?.choices?.find((x) => toHex(x.resource) === toHex(R));
          if (open !== undefined && c !== undefined && open.onChooseSuggestion !== undefined) {
            open.onChooseSuggestion(c);
            open.close();
            return "picked";
          }
          return mock.notices.length > before ? "notice" : undefined;
        },
        30_000,
      );
      if (picked === "picked") done = attempt;
      else {
        await attempt;
        if (Date.now() > deadline)
          throw new Error(`insert: ${mock.notices.slice(before).join(" | ")}`);
        await new Promise((ok) => setTimeout(ok, 3000));
      }
    }
    await answer("the insert preview", click("Insert"));
    await done;
    await this.vault.settle();
    this.#bind();
    if (toBase64url(this.#R as ResourceId) !== resource)
      throw new Error("inserted another section");
  }

  /** The owner's 0.1 collaboration with two shared tasks in a note of their own. */
  async legacyCreate(): Promise<string> {
    const md = `# Legacy\n\n- [ ] La legacy one\n- [ ] Lb legacy two\n`;
    await this.vault.write(LEGACY_NOTE, md);
    await this.vault.command("create-collaboration", ["Legacy", this.server]);
    const R = (await this.runtime.registry()).find((e) => e.localName === "Legacy")
      ?.resourceId as ResourceId;
    for (const t of ["La legacy one", "Lb legacy two"]) {
      this.vault.focus(LEGACY_NOTE, t);
      await this.vault.command("share-task-under-cursor", ["Legacy"]);
    }
    this.legacy.push(R);
    this.#legacyIds = this.#legacyRefs();
    return toBase64url(R);
  }

  async legacyJoin(link: string): Promise<void> {
    await this.join(link, "Legacy");
    const R = (await this.runtime.registry()).find((e) => e.localName === "Legacy")
      ?.resourceId as ResourceId;
    this.legacy.push(R);
    await until(
      "the legacy tasks",
      async () =>
        (await this.runtime.profileOf(R)).replica.objectIds().length >= 2 ? true : undefined,
      60_000,
    );
    await this.vault.write(LEGACY_NOTE, `# Legacy at ${this.name}\n\nMine.\n`);
    for (const t of ["La legacy one", "Lb legacy two"]) {
      this.vault.focus(LEGACY_NOTE, "Mine.");
      await this.vault.command("insert-shared-object", ["Legacy", t]);
    }
    this.#legacyIds = this.#legacyRefs();
  }

  #legacyRefs(): string[] {
    return [...this.vault.read(LEGACY_NOTE).matchAll(/#task:([0-9a-f-]{36})/g)].map(
      (m) => m[1] as string,
    );
  }

  // ---- human edits ----

  #view: EditorView | null = null;
  #saver: ReturnType<typeof setInterval> | null = null;

  /**
   * Opens the section's note in an editor, as a person has it open: a
   * CodeMirror view with the plugin's editor extensions, shown in a Markdown
   * view the plugin finds; Obsidian's autosave writes it to the file.
   */
  openEditor(): void {
    const file = new mock.TFile(SECTION_NOTE);
    const view = new EditorView({
      doc: this.vault.read(SECTION_NOTE),
      extensions: [
        ...(this.vault.host.editorExtensions as Extension[]),
        mock.editorInfoField.init(() => ({ file }) as never),
        mock.editorLivePreviewField.init(() => true),
      ],
    });
    const md = new mock.MarkdownView(file, "");
    const pos = (offset: number) => {
      const line = view.state.doc.lineAt(offset);
      return { line: line.number - 1, ch: offset - line.from };
    };
    Object.defineProperty(md, "editor", {
      value: {
        cm: view,
        getValue: () => view.state.doc.toString(),
        getCursor: () => pos(view.state.selection.main.head),
        getSelection: () =>
          view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to),
        somethingSelected: () => !view.state.selection.main.empty,
        offsetToPos: pos,
        posToOffset: (p: { line: number; ch: number }) =>
          view.state.doc.line(p.line + 1).from + p.ch,
        setCursor: (p: { line: number; ch: number }) =>
          view.dispatch({
            selection: EditorSelection.cursor(view.state.doc.line(p.line + 1).from + p.ch),
          }),
        scrollIntoView: () => undefined,
        focus: () => undefined,
      },
    });
    this.vault.app.workspace.views.push(md);
    this.#view = view;
    // A first transaction so the editor knows its note.
    view.dispatch({ selection: EditorSelection.cursor(0) });
    if (this.#saver !== null) clearInterval(this.#saver);
    this.#saver = setInterval(() => this.#save(), 2000);
  }

  /**
   * Disables and enables the plugin, the note open in the editor: what the
   * editor shows is saved first, the editor gets the new instance's extensions.
   */
  async restart(): Promise<void> {
    this.#save();
    if (this.#saver !== null) clearInterval(this.#saver);
    this.#saver = null;
    const views = this.vault.app.workspace.views;
    views.splice(0, views.length);
    this.#view?.destroy();
    this.#view = null;
    await this.vault.shutdown("clean");
    await this.vault.boot(false);
    this.openEditor();
  }

  /** Obsidian's autosave: the editor's text to the file, a modify event. */
  #save(): void {
    const view = this.#view;
    if (view === null) return;
    const text = view.state.doc.toString();
    if (this.vault.app.vault.files.get(SECTION_NOTE) === text) return;
    this.vault.app.vault.files.set(SECTION_NOTE, text);
    this.vault.app.vault.trigger("modify", new mock.TFile(SECTION_NOTE));
  }

  get #doc(): string {
    return this.#view?.state.doc.toString() ?? this.vault.read(SECTION_NOTE);
  }

  /** One user transaction on the editor. */
  #dispatch(
    changes: { from: number; to?: number; insert?: string },
    userEvent: string,
    caret?: number,
  ): void {
    const view = this.#view as EditorView;
    view.dispatch({
      changes,
      userEvent,
      ...(caret === undefined ? {} : { selection: EditorSelection.cursor(caret) }),
      scrollIntoView: true,
    });
  }

  /** The offset of line `n` (0-based) in the editor. */
  #at(n: number): number {
    const doc = (this.#view as EditorView).state.doc;
    return n + 1 > doc.lines ? doc.length : doc.line(n + 1).from;
  }

  /** One edit a person makes in the note. Returns what it did. */
  async edit(): Promise<string> {
    if (this.#view === null) return "no editor";
    const r = this.rnd();
    if (r < 0.04 && this.#legacyIds.length > 0) return this.#legacyEdit();
    const L = lines(this.#doc);
    const start = L.findIndex((l) => /^<!-- lfcp-section: /.test(l));
    const end = L.findIndex((l) => /^<!-- \/lfcp-section: /.test(l));
    if (start < 0 || end < 0) return "no section in the note";
    const isMine = (l: string) => {
      const m = TASK.exec(l);
      return m !== null && new RegExp(`^${this.me}\\d+ `).test(m[3] ?? "");
    };
    const mine: number[] = [];
    for (let i = start + 1; i < end; i++) if (isMine(L[i] ?? "")) mine.push(i);
    const count = mine.length;
    const pick = () => mine[Math.floor(this.rnd() * mine.length)] as number;
    /** A block of mine with only my Tasks in it. */
    const ownBlock = (filter: (at: number) => boolean = () => true): [number, number] | null => {
      const ok = mine.filter(filter);
      for (let n = 0; n < 8 && ok.length > 0; n++) {
        const at = ok[Math.floor(this.rnd() * ok.length)] as number;
        const [s, e] = blockAt(L, at);
        if (L.slice(s, e).every((l) => !TASK.test(l) || isMine(l))) return [s, e];
      }
      return null;
    };
    if (count === 0 || (r < 0.2 && count < 60)) {
      // A new Task: typed on a new line after a block of mine (or at the section's start).
      const title = `${this.me}${this.#nextId()} ${this.#words()}`;
      if (count === 0) {
        const at = this.#at(start + 1);
        this.#dispatch(
          { from: at, insert: `- [ ] ${title}\n` },
          "input.type",
          at + title.length + 6,
        );
        return `create ${title}`;
      }
      const at = pick();
      const [, e] = blockAt(L, at);
      const pos = this.#at(e) - 1;
      const text = `\n${leading(L[at] ?? "")}- [ ] ${title}`;
      this.#dispatch({ from: pos, insert: text }, "input.type", pos + text.length);
      return `create ${title}`;
    }
    if (r < 0.3 && count > 35) {
      const b = ownBlock();
      if (b === null) return "delete: none";
      this.#dispatch(
        { from: this.#at(b[0]), to: this.#at(b[1]) },
        "delete.selection",
        this.#at(b[0]),
      );
      return `delete ${b[1] - b[0]} lines`;
    }
    if (r < 0.55) {
      // Retitle: the words after the Task's own prefix, retyped.
      const at = pick();
      const line = L[at] as string;
      const m = TASK.exec(line) as RegExpExecArray;
      const prefix = /^\S+/.exec(m[3] ?? "")?.[0] ?? "";
      const from = this.#at(at) + line.indexOf("] ") + 2 + prefix.length;
      const to = this.#at(at) + line.length;
      const words = ` ${this.#words()}`;
      this.#dispatch({ from, to, insert: words }, "input.type", from + words.length);
      return `retitle ${prefix}`;
    }
    if (r < 0.75) {
      // The checkbox.
      const at = pick();
      const line = L[at] as string;
      const box = this.#at(at) + line.indexOf("- [") + 3;
      const done = line[line.indexOf("- [") + 3] === "x";
      this.#dispatch({ from: box, to: box + 1, insert: done ? " " : "x" }, "input.type", box + 1);
      return `toggle ${/^\S+/.exec(TASK.exec(line)?.[3] ?? "")?.[0]}`;
    }
    if (r < 0.88) {
      // Cut a root block of mine, paste it after another root block of mine.
      const b = ownBlock((at) => indentOf(L[at] ?? "") === 0);
      if (b === null) return "move: none";
      const from = this.#at(b[0]);
      const to = this.#at(b[1]);
      const text = this.#doc.slice(from, to);
      this.#dispatch({ from, to }, "delete.cut", from);
      await new Promise((ok) => setTimeout(ok, 300 + this.rnd() * 1200));
      const L2 = lines(this.#doc);
      const e2 = L2.findIndex((l) => /^<!-- \/lfcp-section: /.test(l));
      const roots = L2.flatMap((l, i) => (i < e2 && indentOf(l) === 0 && isMine(l) ? [i] : []));
      if (roots.length === 0) {
        // Put it back where it was.
        this.#dispatch({ from, insert: text }, "input.paste", from + text.length);
        return "move: no target";
      }
      const target = roots[Math.floor(this.rnd() * roots.length)] as number;
      const [, te] = blockAt(L2, target);
      const at = this.#at(te);
      this.#dispatch({ from: at, insert: text }, "input.paste", at + text.length);
      return `move ${b[1] - b[0]} lines`;
    }
    // Nesting: Tab on a block of mine under the Task of mine above it, or
    // Shift+Tab on the last child of a Task of mine.
    const b = ownBlock();
    if (b === null) return "nest: none";
    const indent = indentOf(L[b[0]] ?? "");
    const sibling = (() => {
      for (let i = b[0] - 1; i > start; i--) {
        const l = L[i] ?? "";
        if (l.trim() === "") return null;
        if (indentOf(l) === indent && TASK.test(l)) return i;
        if (indentOf(l) < indent) return null;
      }
      return null;
    })();
    if (sibling !== null && isMine(L[sibling] ?? "") && indent < 12) {
      const changes = [];
      for (let i = b[0]; i < b[1]; i++) changes.push({ from: this.#at(i), insert: "\t" });
      (this.#view as EditorView).dispatch({ changes, userEvent: "input.indent" });
      return "indent";
    }
    const parent = (() => {
      for (let i = b[0] - 1; i > start; i--) {
        const l = L[i] ?? "";
        if (TASK.test(l) && indentOf(l) < indent) return i;
      }
      return null;
    })();
    const after = L[b[1]] ?? "";
    const lastChild = after.trim() === "" || after.startsWith("<!--") || indentOf(after) < indent;
    if (parent !== null && isMine(L[parent] ?? "") && lastChild) {
      const p = leading(L[parent] ?? "");
      const w = leading(L[b[0]] ?? "");
      if (!w.startsWith(p) || w.length === p.length) return "nest: none";
      const cut = w.length - p.length;
      const changes = [];
      for (let i = b[0]; i < b[1]; i++) {
        const lw = leading(L[i] ?? "");
        if (!lw.startsWith(w)) return "nest: mixed";
        changes.push({ from: this.#at(i) + p.length, to: this.#at(i) + p.length + cut });
      }
      (this.#view as EditorView).dispatch({ changes, userEvent: "delete.dedent" });
      return "outdent";
    }
    return "nest: none";
  }

  #nextId(): number {
    // Unique per identity: the current max of mine plus one.
    const md = this.#doc;
    let max = this.#next;
    for (const m of md.matchAll(new RegExp(`- \\[[ x]\\] ${this.me}(\\d+) `, "g")))
      max = Math.max(max, Number(m[1]) + 1);
    this.#next = max + 1;
    return max;
  }

  #words(): string {
    const n = 1 + Math.floor(this.rnd() * 3);
    return Array.from({ length: n }, () => WORDS[Math.floor(this.rnd() * WORDS.length)]).join(" ");
  }

  async #legacyEdit(): Promise<string> {
    // Each legacy Task has one editor: La the owner (a), Lb peer b.
    const md = this.vault.read(LEGACY_NOTE);
    const mine = this.me === "a" ? "La" : this.me === "b" ? "Lb" : null;
    if (mine === null) return "legacy: read only";
    const L = lines(md);
    const at = L.findIndex((l) => new RegExp(`- \\[[ x]\\] ${mine} `).test(l));
    if (at < 0) return "legacy: missing";
    const m = TASK.exec(L[at] ?? "") as RegExpExecArray;
    const tail = /( ?<!-- lfcp-ref: .*)$/.exec(m[3] ?? "")?.[1] ?? "";
    L[at] =
      this.rnd() < 0.5
        ? `${m[1]}- [${m[2] === " " ? "x" : " "}] ${m[3]}`
        : `${m[1]}- [${m[2]}] ${mine} ${this.#words()}${tail}`;
    await this.vault.write(LEGACY_NOTE, L.join("\n"));
    return `legacy ${mine}`;
  }

  // ---- network ----

  /** What the window's "online" does in Obsidian: the plugin's handler runs. */
  onlineEvent(): void {
    for (const d of (
      this.vault.host as unknown as {
        domEvents: { type: string; callback: (e: unknown) => unknown }[];
      }
    ).domEvents)
      if (d.type === "online") d.callback({});
  }

  offline(value: boolean): void {
    this.vault.network.offline = value;
  }

  /** Time (ms) from `since` until a frame arrives from the server, and until nothing waits to be sent. */
  async reconnect(
    since: number,
    ms = 120_000,
  ): Promise<{ inbound: number | null; drained: number | null }> {
    let inbound: number | null = null;
    let drained: number | null = null;
    const deadline = since + ms;
    while (Date.now() < deadline && (inbound === null || drained === null)) {
      if (inbound === null && this.#lastInbound >= since) inbound = this.#lastInbound - since;
      if (drained === null && inbound !== null && (await this.outbound()) === 0)
        drained = Date.now() - since;
      await new Promise((r) => setTimeout(r, 100));
    }
    return { inbound, drained };
  }

  /** When the last frame from the server arrived (epoch ms). */
  get lastInbound(): number {
    return this.#lastInbound;
  }

  async outbound(): Promise<number> {
    return (await this.runtime.storage?.outbound.list())?.length ?? -1;
  }

  // ---- state ----

  /** The model of the section, canonical: its revision, structure and Task fields. */
  model(): { revision: string; canon: string; tasks: number; problems: number } | null {
    if (this.#R === null) return null;
    const port = this.#port();
    const R = toBase64url(this.#R);
    const snap = port.snapshot(R, this.#sid);
    if (snap === undefined) return null;
    const tasks: Record<string, unknown> = {};
    const nodes: Record<string, unknown> = {};
    const walk = (parent: string) => {
      for (const id of snap.order[parent] ?? []) {
        const n = snap.nodes[id] as unknown as Record<string, unknown>;
        nodes[id] = { ...n, parent };
        if (n.kind === "task") {
          const t = port.task(R, id);
          tasks[id] = t === undefined ? null : { title: t.title, status: t.status };
        }
        walk(id);
      }
    };
    walk("");
    const canon = JSON.stringify({ title: snap.title, order: snap.order, nodes, tasks });
    return {
      revision: snap.revision,
      canon,
      tasks: Object.keys(tasks).length,
      problems: snap.problems.length,
    };
  }

  /** What differs between the note and the model it projects (empty: equal). */
  noteVsModel(): string[] {
    if (this.#R === null) return ["no section"];
    const port = this.#port();
    const R = toBase64url(this.#R);
    const snap = port.snapshot(R, this.#sid);
    if (snap === undefined) return ["no model"];
    const md = this.#doc;
    const section = parseSections(md).sections[0];
    if (section === undefined) return ["no section in the note"];
    const { state, unbound } = markdownState(md, section);
    const out: string[] = [];
    // Saved as Obsidian saves: the file is what the editor shows.
    this.#save();
    if (this.vault.read(SECTION_NOTE) !== md) out.push("the file differs from the editor");
    if (unbound.length > 0) out.push(`${unbound.length} unbound lines`);
    const visible = (order: Readonly<Record<string, readonly string[]>>) => {
      const seq: string[] = [];
      const walk = (p: string) => {
        for (const id of order[p] ?? []) {
          seq.push(`${p}>${id}`);
          walk(id);
        }
      };
      walk("");
      return seq;
    };
    const a = visible(state.order);
    const b = visible(snap.order);
    if (a.join() !== b.join()) {
      const i = a.findIndex((x, k) => x !== b[k]);
      out.push(`structure differs at ${i}: note ${a[i]} model ${b[i]} (${a.length}/${b.length})`);
    }
    for (const [id, n] of Object.entries(state.nodes)) {
      if (n.kind === "task") {
        const t = port.task(R, id);
        const m = TASK.exec(n.line ?? "");
        const title = (m?.[3] ?? "").replace(/ ?<!--.*-->$/, "");
        const done = m?.[2] === "x";
        if (t === undefined) out.push(`task ${id} not in the model`);
        else if (t.title !== title || (t.status === "done") !== done)
          out.push(`task ${id}: note "${title}" ${done} model "${t.title}" ${t.status}`);
      } else {
        const mn = snap.nodes[id] as { text?: string } | undefined;
        if (mn?.text !== undefined && n.text !== undefined && mn.text !== n.text)
          out.push(`text ${id} differs`);
      }
    }
    return out;
  }

  /** The legacy Tasks as the model has them, and whether the note shows them so. */
  async legacyState(): Promise<{ canon: string; mismatch: string[] }> {
    const R = this.legacy[0];
    if (R === undefined) return { canon: "", mismatch: [] };
    const replica = (await this.runtime.profileOf(R)).replica;
    const md = this.vault.read(LEGACY_NOTE);
    const tasks: Record<string, unknown> = {};
    const mismatch: string[] = [];
    for (const id of [...replica.objectIds()].sort()) {
      const t = replica.task(id)?.task;
      tasks[id] = t === undefined ? null : { title: t.title, status: t.status };
      const line = lines(md).find(
        (l, i, all) => l.includes(id) || (all[i + 1] ?? "").includes(`#task:${id}`),
      );
      const m = TASK.exec(line ?? "");
      if (t !== undefined && m !== null) {
        const title = (m[3] ?? "").replace(/ ?<!--.*-->$/, "");
        if (title !== t.title || (m[2] === "x") !== (t.status === "done"))
          mismatch.push(`legacy ${id}: note "${title}" model "${t.title}" ${t.status}`);
      }
    }
    return { canon: JSON.stringify(tasks), mismatch };
  }

  /** What this device holds of a section Resource (base64url): for a failure's report. */
  async diag(resource: string): Promise<Record<string, unknown>> {
    const R = fromBase64url(resource) as ResourceId;
    const runtime = this.runtime;
    const storage = runtime.storage;
    const entry = (await runtime.registry()).find((e) => toHex(e.resourceId) === toHex(R));
    const units: Record<string, number> = {};
    const epochs: Record<string, number> = {};
    if (storage !== undefined && storage !== null)
      for (const st of [
        "seen",
        "merged",
        "profile-pending",
        "held",
        "quarantined",
        "equivocation",
        "local-failure",
      ] as const)
        for (const u of await storage.dataUnits.withStatus(R, st)) {
          units[st] = (units[st] ?? 0) + 1;
          epochs[String(u.dataEpoch)] = (epochs[String(u.dataEpoch)] ?? 0) + 1;
        }
    const profile = runtime.sectionProfile(R);
    const snap = profile?.replica.snapshot();
    return {
      entry:
        entry === undefined
          ? null
          : {
              profile: entry.profile,
              state: (entry as { state?: unknown }).state,
              localName: entry.localName,
            },
      phase: runtime.phase(R),
      load: runtime.sectionLoad(R) ?? null,
      held: profile?.heldUnits().length ?? null,
      classification: snap?.classification ?? null,
      sectionId:
        (profile?.replica.toJSON() as { section?: { id?: unknown } } | undefined)?.section?.id ??
        null,
      nodes: snap === undefined ? null : Object.keys(snap.nodes).length,
      units,
      epochs,
      snapshots:
        (await storage?.snapshots.list(R))?.map((x) => ({
          epoch: String(x.dataEpoch),
          seq: String(x.snapshotSeq),
          bytes: x.bytes.byteLength,
        })) ?? null,
      outbound: (await storage?.outbound.list(R))?.length ?? null,
      refusal: runtime.refusal(R)?.code ?? null,
      sections: await this.sectionStates(),
    };
  }

  /** Each section's state as its status shows it (the plugin refreshes it every 2 s). */
  async sectionStates(): Promise<
    { state: string; conditions: readonly string[]; pending: number }[]
  > {
    const d = (await this.vault.plugin.sections?.diagnostics()) ?? { sections: [] };
    return d.sections.map((s) => ({
      state: s.state,
      conditions: s.conditions,
      pending: s.pendingBatches,
    }));
  }

  /** Deletes the Task titled `title` (its block) in the editor, as a cut nobody pastes. */
  deleteTask(title: string): void {
    const L = lines(this.#doc);
    const at = L.findIndex((l) => TASK.exec(l)?.[3] === title);
    if (at < 0) throw new Error(`no Task "${title}"`);
    const [from, to] = blockAt(L, at);
    this.#dispatch({ from: this.#at(from), to: this.#at(to) }, "delete.cut", this.#at(from));
  }

  /** Replaces `from` by `to` in the line of the Task titled `title`, through the editor's API (Obsidian's editor.setLine). */
  editTask(title: string, from: string, to: string): void {
    const L = lines(this.#doc);
    const at = L.findIndex((l) => TASK.exec(l)?.[3]?.replace(/ ?<!--.*-->$/, "") === title);
    if (at < 0) throw new Error(`${this.name}: no Task "${title}" in\n${this.#doc}`);
    const line = L[at] as string;
    const i = line.indexOf(from);
    if (i < 0) throw new Error(`no "${from}" in "${line}"`);
    const start = this.#at(at) + i;
    // As Obsidian's editor.setLine does: no userEvent (an API edit).
    (this.#view as EditorView).dispatch({
      changes: { from: start, to: start + from.length, insert: to },
    });
  }

  /** Whether the section's card offers "Review conflicts…" (and closes the card). */
  async reviewConflicts(): Promise<boolean> {
    const sections = this.vault.plugin.sections;
    const key = (await sections?.diagnostics())?.sections[0]?.key;
    if (sections === null || key === undefined) throw new Error("no section");
    // The card's actions as the host passes them (the mock cannot render the card).
    const { SectionCardModal } = await import("../../src/obsidian/ui/section-card");
    const P = SectionCardModal.prototype as unknown as { open: () => void };
    const open = P.open;
    let actions: readonly { label: string }[] = [];
    P.open = function (this: { actions: readonly { label: string }[] }) {
      actions = this.actions;
    };
    try {
      await sections.openCard(key, "Soak");
    } finally {
      P.open = open;
    }
    return actions.some((x) => x.label === "Review conflicts…");
  }

  /** The metrics of a sample; pass times since the last one. */
  async sample(): Promise<Record<string, unknown>> {
    const passes = passTimes.splice(0);
    const mem = process.memoryUsage();
    let unitBytes = 0;
    let units = 0;
    let snapshotBytes = 0;
    const storage = this.runtime.storage;
    if (storage !== undefined && storage !== null && this.#R !== null) {
      for (const u of await storage.dataUnits.withStatus(this.#R, "merged")) {
        units++;
        unitBytes += u.bytes.byteLength;
      }
      for (const s of await storage.snapshots.list(this.#R)) snapshotBytes += s.bytes.byteLength;
    }
    const diag = (await this.vault.plugin.sections?.diagnostics()) ?? {
      sections: [],
      candidates: [],
    };
    // The harness's own logs (dialogs) are not the plugin's memory.
    for (let i = mock.modals.length - 1; i >= 0; i--)
      if (!(mock.modals[i] as mock.Modal).isOpen) mock.modals.splice(i, 1);
    return {
      rssMiB: +(mem.rss / 2 ** 20).toFixed(1),
      heapMiB: +(mem.heapUsed / 2 ** 20).toFixed(1),
      // WASM linear memory (Automerge's above all): it only grows (wasm memory never shrinks).
      wasmMiB: +(
        (
          (globalThis as { __soakWasm?: { exports: { memory?: WebAssembly.Memory } }[] })
            .__soakWasm ?? []
        )
          .map((i) => i.exports.memory?.buffer.byteLength ?? 0)
          .reduce((a, b) => a + b, 0) /
        2 ** 20
      ).toFixed(1),
      outbound: await this.outbound(),
      passes: passes.length,
      passP50: percentile(passes, 50),
      passP95: percentile(passes, 95),
      passMax: passes.length === 0 ? null : Math.max(...passes),
      units,
      unitBytes,
      snapshotBytes,
      noteBytes: this.#doc.length,
      sections: diag.sections.map((s) => ({
        state: s.state,
        conditions: s.conditions,
        pending: s.pendingBatches,
      })),
      candidates: diag.candidates.length,
    };
  }

  /** A note's text as the user sees it: the editor's for the open note. */
  text(path: string): string {
    return path === SECTION_NOTE ? this.#doc : this.vault.read(path);
  }

  /** The notices since the last call: the plugin's own and its dialogs'. */
  notices(): string[] {
    return [...mock.notices.splice(0), ...this.vault.prompter.notices.splice(0)];
  }
}
