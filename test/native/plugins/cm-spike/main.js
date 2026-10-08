// The ADR 0001 spike plugin (native harness only, never shipped). It uses
// the same public API the plugin would: registerEditorExtension, the
// app-provided @codemirror modules and editorInfoField. Specs drive it
// through window.__lfcpSpike.

const { Plugin, editorInfoField } = require("obsidian");
const { ViewPlugin } = require("@codemirror/view");
const { Annotation, EditorState, Transaction } = require("@codemirror/state");

const origin = Annotation.define();

class CmSpike extends Plugin {
  onload() {
    const spike = {
      log: [],
      views: new Set(),
      /** When set: (tr) => extra changes appended to a user's own transaction. */
      bind: null,
      origin,
      Transaction,
      clear() {
        spike.log.length = 0;
      },
      viewsOf(path) {
        return [...spike.views].filter((v) => v.state.field(editorInfoField, false)?.file?.path === path);
      },
      /** Dispatches a plugin change in `view`: annotated, optionally kept out of history. */
      dispatch(view, changes, { userEvent, history = true, op = "op" } = {}) {
        const annotations = [origin.of(op)];
        if (userEvent) annotations.push(Transaction.userEvent.of(userEvent));
        if (!history) annotations.push(Transaction.addToHistory.of(false));
        view.dispatch({ changes, annotations });
      },
    };
    window.__lfcpSpike = spike;
    const recorder = ViewPlugin.fromClass(
      class {
        constructor(view) {
          this.view = view;
          spike.views.add(view);
        }
        update(u) {
          const t0 = performance.now();
          for (const tr of u.transactions) {
            if (!tr.docChanged && !tr.annotation(origin)) continue;
            const changes = [];
            tr.changes.iterChanges((fromA, toA, fromB, toB, text) =>
              changes.push({ fromA, toA, inserted: text.toString() }),
            );
            spike.log.push({
              path: u.state.field(editorInfoField, false)?.file?.path ?? null,
              view: [...spike.views].indexOf(u.view),
              userEvent: tr.annotation(Transaction.userEvent) ?? null,
              origin: tr.annotation(origin) ?? null,
              addToHistory: tr.annotation(Transaction.addToHistory) ?? null,
              remote: tr.annotation(Transaction.remote) ?? null,
              changes,
              composing: u.view.composing,
              t: performance.now(),
            });
          }
          spike.updateMs = (spike.updateMs ?? 0) + (performance.now() - t0);
        }
        destroy() {
          spike.views.delete(this.view);
        }
      },
    );
    // S2: a filter that adds the plugin's own change to a user's input transaction.
    const filter = EditorState.transactionFilter.of((tr) => {
      if (spike.bind === null || !tr.docChanged || tr.annotation(origin)) return tr;
      const extra = spike.bind(tr);
      if (!extra) return tr;
      return [tr, { changes: extra, sequential: true, annotations: origin.of("bind") }];
    });
    this.registerEditorExtension([recorder, filter]);
  }

  onunload() {
    delete window.__lfcpSpike;
  }
}

module.exports = CmSpike;
