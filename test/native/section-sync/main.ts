// The section engine in a real Obsidian editor, on the fake SDK port
// (native harness only, never shipped; LFCP-02-041..043). Built into
// plugins/section-sync/main.js by scripts/build-native-harness.mjs.
// Specs drive it through window.__lfcpSectionSync. LFCP-02-064: the
// production status extension too, its statuses from mock facts (no SDK
// here), with the same next-problem path and live region as the plugin.

import { principalId, toBase64url } from "@openlfcp/core";
import { MarkdownView, Plugin } from "obsidian";
import { MemorySectionBaseStore, markdownState } from "../../../src/core/sections/base";
import { SectionEngine } from "../../../src/core/sections/engine";
import { MemorySectionJournalStore } from "../../../src/core/sections/journal";
import { parseSections } from "../../../src/core/sections/parser";
import { Announcer } from "../../../src/core/status/a11y";
import { type StatusFacts, type StatusView, statusView } from "../../../src/core/status/reducer";
import { LiveRegion } from "../../../src/obsidian/live-region";
import { type EditorSyncStatus, sectionEditorExtension } from "../../../src/obsidian/section-editor";
import {
  goToNextProblem,
  sectionStatusExtension,
  setSectionStatuses,
} from "../../../src/obsidian/section-status";
import { FakeSectionPort } from "../../core/sections/fake-port";

const uuid = (): string => {
  // UUIDv7-shaped and unique enough for a harness run.
  const hex = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

export default class SectionSyncHarness extends Plugin {
  override onload(): void {
    const port = new FakeSectionPort();
    const engine = new SectionEngine({
      port,
      journal: new MemorySectionJournalStore(),
      bases: new MemorySectionBaseStore(),
      newNodeId: uuid,
      newOperationId: uuid,
      createdBy: principalId(new Uint8Array(32).fill(4)),
      newProjectionId: uuid,
      tasks: () => undefined,
      newTask: (line, id) => ({ id, title: line.replace(/^[ \t]*[-*+][ \t]+\[.\][ \t]*/, "").trim() }),
    });
    const passes: { path: string; changes: number; local: string | undefined }[] = [];
    const statuses: { path: string; status: EditorSyncStatus; at: number }[] = [];
    const errors: string[] = [];
    const editor = sectionEditorExtension({
      engine: () => engine,
      onPass: (path, pass) =>
        passes.push({ path, changes: pass.changes.length, local: pass.sections[0]?.local?.kind }),
      onStatus: (path, status) => statuses.push({ path, status, at: Date.now() }),
      onError: (_path, error) => errors.push(String(error)),
    });
    this.registerEditorExtension(editor.extension);
    const healthy: StatusFacts = {
      session: "s",
      revision: 1,
      replica: "loaded",
      access: "writer",
      pendingControl: [],
      connection: "connected",
      catchUp: "current-at-checkpoint",
      problems: [],
      batches: [],
      acceptanceEvidence: "available",
      projections: [{ id: "p", source: "clean", application: "current" }],
    };
    let current: ReadonlyMap<string, StatusView> = new Map();
    const opened: string[] = [];
    const status = sectionStatusExtension(
      () => current,
      (key) => opened.push(key),
    );
    this.registerEditorExtension(status.extension);
    const app = this.app;
    const live = new LiveRegion(document);
    this.register(() => live.detach());
    const announcer = new Announcer();
    const announced: string[] = [];
    (window as unknown as Record<string, unknown>).__lfcpSectionSync = {
      port,
      passes,
      statuses,
      errors,
      /** The model of the first section of `markdown`, as that note shows it. */
      host(markdown: string): string {
        const s = parseSections(markdown).sections[0];
        if (s === undefined) throw new Error("no section");
        const resource = toBase64url(s.ref.resourceId);
        port.host(resource, s.ref.sectionId, markdownState(markdown, s).state);
        return resource;
      },
      /** A collaborator's edit of a node's Text, then projected into `path`. */
      remoteText(resource: string, nodeId: string, text: string, path: string): void {
        port.remote(resource, (s) => {
          const n = s.state.nodes[nodeId];
          if (n === undefined) throw new Error(`no node ${nodeId}`);
          s.state = { ...s.state, nodes: { ...s.state.nodes, [nodeId]: { ...n, text } } };
        });
        editor.remoteChanged(path);
      },
      /** A pass now on the note (seeds the base on first sight). */
      sync: (path: string) => editor.remoteChanged(path),
      model: (resource: string) => port.sections.get(resource)?.state,
      /** Section statuses from mock facts, by section key; new blocking conditions said once. */
      setStatuses(facts: Record<string, Partial<StatusFacts>>): void {
        current = new Map(
          Object.entries(facts).map(([k, f]) => [k, statusView({ ...healthy, ...f })]),
        );
        for (const v of status.views) v.dispatch({ effects: setSectionStatuses.of(current) });
        const said = announcer.next(current, () => "Joint launch");
        if (said.length > 0) {
          announced.push(...said);
          live.announce(said.join(" "));
        }
      },
      /** The plugin's "Go to next shared section problem" path, in the active editor. */
      nextProblem(): string {
        const md = app.workspace.getActiveViewOfType(MarkdownView);
        const cm = [...status.views].find((v) => md?.containerEl.contains(v.dom) === true);
        const said = goToNextProblem(cm, current);
        live.announce(said.text);
        return said.text;
      },
      live: () => live.text,
      announced,
      opened,
      changes: () => port.changes,
    };
  }

  override onunload(): void {
    delete (window as unknown as Record<string, unknown>).__lfcpSectionSync;
  }
}
