// The LFCP-02-048 spike plugin (native harness only, never shipped): hides
// the binding lines of shared sections (section boundaries, node markers,
// child-line Task refs) in Live Preview with block replace decorations from
// a StateField, revealing a line while the selection touches it or while
// "show metadata" is on. Specs drive it through window.__lfcpMarkers.

const { Plugin, editorLivePreviewField } = require("obsidian");
const { Decoration, EditorView } = require("@codemirror/view");
const { StateEffect, StateField, RangeSetBuilder } = require("@codemirror/state");

// A whole line that is only an LFCP binding comment.
const BINDING = /^[ \t]*<!--[ \t]+\/?lfcp-(section|node|ref):[^>]*-->[ \t]*$/;
const setShow = StateEffect.define();

class MarkerSpike extends Plugin {
  onload() {
    const spike = { enabled: true, buildMs: 0, builds: 0, setShow };
    window.__lfcpMarkers = spike;

    const build = (state, show) => {
      const t0 = performance.now();
      const builder = new RangeSetBuilder();
      const live = state.field(editorLivePreviewField, false) === true;
      if (spike.enabled && live && !show) {
        const touched = new Set();
        for (const r of state.selection.ranges) {
          const a = state.doc.lineAt(r.from).number;
          const b = state.doc.lineAt(r.to).number;
          for (let n = a; n <= b; n++) touched.add(n);
        }
        for (let n = 1; n <= state.doc.lines; n++) {
          const line = state.doc.line(n);
          if (touched.has(n) || !BINDING.test(line.text)) continue;
          builder.add(line.from, line.to, Decoration.replace({ block: true }));
        }
      }
      spike.buildMs += performance.now() - t0;
      spike.builds++;
      return builder.finish();
    };

    const field = StateField.define({
      create: (state) => ({ show: false, deco: build(state, false) }),
      update(value, tr) {
        let show = value.show;
        for (const e of tr.effects) if (e.is(setShow)) show = e.value;
        if (
          show !== value.show ||
          tr.docChanged ||
          tr.selection ||
          tr.startState.field(editorLivePreviewField, false) !==
            tr.state.field(editorLivePreviewField, false)
        )
          return { show, deco: build(tr.state, show) };
        return value;
      },
      provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
    });
    this.registerEditorExtension(field);
  }

  onunload() {
    delete window.__lfcpMarkers;
  }
}

module.exports = MarkerSpike;
