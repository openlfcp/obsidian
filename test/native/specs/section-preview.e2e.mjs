// The shared sections preview in Shared Tasks itself (`sectionsPreview` on):
// the plugin's runtime, the real SDK, its install database. A section
// Resource is created and its section committed locally (no server: the
// session never connects), then typing in a note becomes a commit in the
// section's replica, with the new paragraph's marker written. The flag is
// switched off again at the end.

const SECTION_ID = "268a166f-4891-7243-840e-e7fea9fe6390";
const FILE = "preview.md";

/** Shared Tasks restarted with `sectionsPreview` set, runtime ready. */
async function restartWith(preview) {
  await browser.executeObsidian(async ({ app }, preview) => {
    const plugin = app.plugins.plugins["shared-tasks"];
    plugin.settings.sectionsPreview = preview;
    await plugin.saveData(plugin.settings);
    await app.plugins.disablePlugin("shared-tasks");
    await app.plugins.enablePlugin("shared-tasks");
    const p = app.plugins.plugins["shared-tasks"];
    for (let i = 0; i < 100 && p.runtime?.status.kind !== "ready"; i++)
      await new Promise((r) => setTimeout(r, 50));
  }, preview);
}

const replicaText = () =>
  browser.executeObsidian(({ app }) => {
    const p = app.plugins.plugins["shared-tasks"];
    const snap = p.runtime.sectionProfile(window.__lfcpPreviewR)?.replica.snapshot();
    return snap === undefined
      ? null
      : Object.values(snap.nodes)
          .map((n) => n.text)
          .filter((t) => t !== undefined);
  });

describe("shared sections preview in Shared Tasks (real SDK, no server)", () => {
  after(async () => {
    await restartWith(false);
  });

  it("typing in a section becomes a commit in the section's replica", async () => {
    await restartWith(true);
    // A section Resource of this vault, and its section, committed locally.
    const note = await browser.executeObsidian(async ({ app }, sectionId) => {
      const runtime = app.plugins.plugins["shared-tasks"].runtime;
      const url = "ws://127.0.0.1:9/v1/ws";
      const R = await runtime.createSectionResource({ name: "Preview", endpoints: [url], coordinatorUrl: url });
      await runtime.openSection(R);
      await runtime.commitSection(
        R,
        [{ intent: "section.create", sectionId, title: "Joint launch", createdBy: runtime.status.principalId }],
        { operationId: "create" },
      );
      window.__lfcpPreviewR = R;
      const b64 = btoa(String.fromCharCode(...R)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      const ref = `lfcp1:${b64}#section:${sectionId}`;
      return ["Private intro.", "", "## Joint launch", `<!-- lfcp-section: ${ref} -->`, `<!-- /lfcp-section: ${ref} -->`, "", "Private outro.", ""].join("\n");
    }, SECTION_ID);
    // The plugin opens the Resource and finds the note at start.
    await browser.executeObsidian(async ({ app }, file, note) => {
      await app.vault.create(file, note);
    }, FILE, note);
    await restartWith(true);
    await browser.executeObsidian(async ({ app, obsidian }, file) => {
      const leaf = app.workspace.getLeaf(false);
      await leaf.openFile(app.vault.getFileByPath(file), { state: { mode: "source", source: false } });
      app.workspace.setActiveLeaf(leaf, { focus: true });
      const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
      for (let i = 0; i < 40 && !view.editor.hasFocus(); i++) {
        view.editor.focus();
        await new Promise((r) => setTimeout(r, 50));
      }
      view.editor.setCursor({ line: 3, ch: view.editor.getLine(3).length });
    }, FILE);
    // The note's base is seeded (the empty section shows the model).
    await browser.waitUntil(
      () =>
        browser.executeObsidian(async ({ app }, file) => {
          const v = await app.plugins.plugins["shared-tasks"].runtime.localState.get(
            `section-projections:${file}`,
          );
          return Array.isArray(v) && v.length > 0;
        }, FILE),
      { timeout: 8000, timeoutMsg: "base seeded" },
    );
    await browser.keys(["Enter", "D", "r", "a", "f", "t"]);
    await browser.executeObsidian(({ app, obsidian }) => {
      app.workspace.getActiveViewOfType(obsidian.MarkdownView).editor.cm.contentDOM.blur();
    });
    await browser.waitUntil(async () => (await replicaText())?.includes("Draft") === true, {
      timeout: 8000,
      timeoutMsg: "committed into the replica",
    });
    const text = await browser.executeObsidian(({ app, obsidian }) =>
      app.workspace.getActiveViewOfType(obsidian.MarkdownView).editor.getValue(),
    );
    console.log(`EVIDENCE ${JSON.stringify({ id: "SECTIONS-PREVIEW", text })}`);
    expect(text).toMatch(/<!-- lfcp-node: paragraph:[0-9a-f-]{36} -->\nDraft\n/);
    expect(text.startsWith("Private intro.\n")).toBe(true);
    expect(text.endsWith("Private outro.\n")).toBe(true);
  });
});

describe("Share section… preview (LFCP-02-049, flag on)", () => {
  before(async () => {
    // A server that never answers: creation stays on this device, nothing leaves it.
    await browser.executeObsidian(async ({ app }) => {
      const plugin = app.plugins.plugins["shared-tasks"];
      plugin.settings.defaultServer = "ws://127.0.0.1:9/v1/ws";
      await plugin.saveData(plugin.settings);
    });
    await restartWith(true);
  });
  after(async () => {
    await restartWith(false);
  });

  /** Opens `file` with `text`, caret on `line`, runs the command and returns what the dialog shows. */
  async function preview(file, text, line) {
    return browser.executeObsidian(
      async ({ app, obsidian }, file, text, line) => {
        if (app.vault.getFileByPath(file) === null) await app.vault.create(file, text);
        else await app.vault.adapter.write(file, text);
        const leaf = app.workspace.getLeaf(false);
        await leaf.openFile(app.vault.getFileByPath(file), { state: { mode: "source", source: true } });
        app.workspace.setActiveLeaf(leaf, { focus: true });
        const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
        for (let i = 0; i < 40 && view.editor.getValue() !== text; i++)
          await new Promise((r) => setTimeout(r, 50));
        view.editor.setCursor({ line, ch: 0 });
        app.commands.executeCommandById("shared-tasks:share-section");
        let modal = null;
        for (let i = 0; i < 40 && modal === null; i++) {
          await new Promise((r) => setTimeout(r, 50));
          modal = document.querySelector(".modal-container .modal");
        }
        const boxes = [...modal.querySelectorAll(".openlfcp-share-content")].map((b) => b.textContent);
        const problems = [...modal.querySelectorAll(".openlfcp-share-problem")].map((p) => p.textContent);
        const share = [...modal.querySelectorAll("button")].find((b) => b.textContent === "Share");
        const result = {
          heading: modal.querySelector("h3")?.textContent,
          boxes,
          problems,
          shareDisabled: share?.disabled === true,
        };
        [...modal.querySelectorAll("button")].find((b) => b.textContent === "Cancel")?.click();
        return result;
      },
      file,
      text,
      line,
    );
  }

  it("shows exactly the range under the heading; private text stays outside", async () => {
    const note = [
      "PRIVATE_BEFORE_8f3a: budget and personal thoughts.",
      "",
      "## Launch",
      "- [ ] Prepare contract",
      "  Draft contract",
      "",
      "## Other",
      "PRIVATE_AFTER_71c2: do not transmit.",
      "",
    ].join("\n");
    const shown = await preview("share-range.md", note, 3);
    console.log(`EVIDENCE ${JSON.stringify({ id: "SHARE-PREVIEW", shown })}`);
    expect(shown.heading).toBe('Share section "Launch"');
    expect(shown.boxes).toEqual(["- [ ] Prepare contract\n  Draft contract"]);
    expect(shown.problems).toEqual([]);
    expect(shown.shareDisabled).toBe(false);
  });

  it("Share creates the section: the range bound, its content in the replica, private text outside (LFCP-02-050)", async () => {
    const note = [
      "PRIVATE_BEFORE_8f3a: budget.",
      "",
      "## Launch",
      "- [ ] Prepare contract",
      "",
      "Draft the plan.",
      "",
      "## Other",
      "PRIVATE_AFTER_71c2: do not transmit.",
      "",
    ].join("\n");
    await browser.executeObsidian(
      async ({ app, obsidian }, file, text) => {
        await app.vault.create(file, text);
        const leaf = app.workspace.getLeaf(false);
        await leaf.openFile(app.vault.getFileByPath(file), { state: { mode: "source", source: true } });
        app.workspace.setActiveLeaf(leaf, { focus: true });
        const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
        for (let i = 0; i < 40 && view.editor.getValue() !== text; i++)
          await new Promise((r) => setTimeout(r, 50));
        view.editor.setCursor({ line: 3, ch: 0 });
        app.commands.executeCommandById("shared-tasks:share-section");
        let share = null;
        for (let i = 0; i < 40 && share === null; i++) {
          await new Promise((r) => setTimeout(r, 50));
          share =
            [...document.querySelectorAll(".modal-container .modal button")].find(
              (b) => b.textContent === "Share",
            ) ?? null;
        }
        share.click();
      },
      "share-create.md",
      note,
    );
    await browser.waitUntil(
      () =>
        browser.executeObsidian(({ app, obsidian }) =>
          app.workspace
            .getActiveViewOfType(obsidian.MarkdownView)
            .editor.getValue()
            .includes("<!-- /lfcp-section: "),
        ),
      { timeout: 15000, timeoutMsg: "section bound" },
    );
    const out = await browser.executeObsidian(async ({ app, obsidian }) => {
      const text = app.workspace.getActiveViewOfType(obsidian.MarkdownView).editor.getValue();
      const runtime = app.plugins.plugins["shared-tasks"].runtime;
      const texts = [];
      for (const e of await runtime.registry()) {
        const snap = runtime.sectionProfile(e.resourceId)?.replica.snapshot();
        if (snap?.title?.value === "Launch")
          texts.push(...Object.values(snap.nodes).map((n) => n.text).filter((t) => t !== undefined));
      }
      return { text, texts };
    });
    console.log(`EVIDENCE ${JSON.stringify({ id: "SHARE-CREATE", ...out })}`);
    expect(out.texts).toContain("Draft the plan.");
    expect(out.texts.join(" ")).not.toContain("PRIVATE_");
    expect(out.text).toMatch(
      /^PRIVATE_BEFORE_8f3a: budget\.\n\n## Launch\n<!-- lfcp-section: lfcp1:[\w-]+#section:[0-9a-f-]{36} -->\n- \[ \] Prepare contract\n/,
    );
    expect(out.text).toMatch(/<!-- lfcp-node: paragraph:[0-9a-f-]{36} -->\nDraft the plan\.\n/);
    expect(out.text).toMatch(/<!-- \/lfcp-section: [^>]+ -->\n\n## Other\nPRIVATE_AFTER_71c2: do not transmit\.\n$/);
  });

  it("Insert shared section… writes the loaded section, complete, after the paragraph at the cursor (LFCP-02-052)", async () => {
    const note = ["# Week", "", "Private intro,", "two lines.", "", "## Later", "Private.", ""].join("\n");
    await browser.executeObsidian(
      async ({ app, obsidian }, file, text) => {
        await app.vault.create(file, text);
        const leaf = app.workspace.getLeaf(false);
        await leaf.openFile(app.vault.getFileByPath(file), { state: { mode: "source", source: true } });
        app.workspace.setActiveLeaf(leaf, { focus: true });
        const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
        for (let i = 0; i < 40 && view.editor.getValue() !== text; i++)
          await new Promise((r) => setTimeout(r, 50));
        view.editor.setCursor({ line: 2, ch: 0 });
        app.commands.executeCommandById("shared-tasks:insert-section");
        let item = null;
        for (let i = 0; i < 40 && item === null; i++) {
          await new Promise((r) => setTimeout(r, 50));
          item =
            [...document.querySelectorAll(".suggestion-item")].find((e) => e.textContent === "Launch") ??
            null;
        }
        item.click();
        let insert = null;
        for (let i = 0; i < 40 && insert === null; i++) {
          await new Promise((r) => setTimeout(r, 50));
          insert =
            [...document.querySelectorAll(".modal-container .modal button")].find(
              (b) => b.textContent === "Insert",
            ) ?? null;
        }
        insert.click();
      },
      "insert-target.md",
      note,
    );
    await browser.waitUntil(
      () =>
        browser.executeObsidian(({ app, obsidian }) =>
          app.workspace
            .getActiveViewOfType(obsidian.MarkdownView)
            .editor.getValue()
            .includes("<!-- /lfcp-section: "),
        ),
      { timeout: 10000, timeoutMsg: "section inserted" },
    );
    // A pass on the inserted section has nothing to change or send.
    await new Promise((r) => setTimeout(r, 500));
    const out = await browser.executeObsidian(async ({ app, obsidian }) => {
      const text = app.workspace.getActiveViewOfType(obsidian.MarkdownView).editor.getValue();
      const source = await app.vault.adapter.read("share-create.md");
      return { text, source };
    });
    console.log(`EVIDENCE ${JSON.stringify({ id: "INSERT-SECTION", text: out.text })}`);
    expect(out.text.startsWith("# Week\n\nPrivate intro,\ntwo lines.\n\n## Launch\n<!-- lfcp-section: ")).toBe(true);
    expect(out.text.endsWith("\n\n## Later\nPrivate.\n")).toBe(true);
    // The same section, bound to the same nodes as the note it was shared from.
    const ids = (t) => [...t.matchAll(/lfcp-(?:node|ref): [^ ]*?([0-9a-f]{8}-[0-9a-f-]{27})/g)].map((m) => m[1]);
    expect(ids(out.text)).toEqual(ids(out.source));
    expect(out.text).toContain("- [ ] Prepare contract\n");
    expect(out.text).toContain("Draft the plan.\n");
  });

  it("a heading inside blocks the share, with a reason", async () => {
    const note = ["## Launch", "- [ ] One", "### Inside", "text", ""].join("\n");
    const shown = await preview("share-nested.md", note, 0);
    expect(shown.problems).toHaveLength(1);
    expect(shown.shareDisabled).toBe(true);
  });
});
