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

  it("Invite collaborator refuses a section its server does not hold yet (LFCP-02-051)", async () => {
    await browser.executeObsidian(async () => {
      for (const n of document.querySelectorAll(".notice")) n.remove();
    });
    await browser.executeObsidian(async ({ app }) => {
      app.commands.executeCommandById("shared-tasks:invite-collaborator");
      let item = null;
      for (let i = 0; i < 40 && item === null; i++) {
        await new Promise((r) => setTimeout(r, 50));
        item =
          [...document.querySelectorAll(".suggestion-item")].find(
            (e) => e.firstElementChild?.textContent === "Launch",
          ) ?? null;
      }
      item.click();
    });
    const notice = await browser.waitUntil(
      () =>
        browser.executeObsidian(() =>
          [...document.querySelectorAll(".notice")]
            .map((n) => n.textContent)
            .find((t) => t.includes("not on its server yet")),
        ),
      { timeout: 8000, timeoutMsg: "the not-hosted notice" },
    );
    console.log(`EVIDENCE ${JSON.stringify({ id: "INVITE-NOT-HOSTED", notice })}`);
    expect(notice).toContain("Host it first");
  });

  it("the shared mark and status after the heading: the same in Live Preview and Reading, the note untouched (LFCP-02-058)", async () => {
    const read = (mode) =>
      browser.executeObsidian(
        async ({ app, obsidian }, mode) => {
          const leaf = app.workspace.getLeaf(false);
          await leaf.openFile(app.vault.getFileByPath("share-create.md"), {
            state: { mode, source: false },
          });
          const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
          let badge = null;
          for (let i = 0; i < 60 && badge === null; i++) {
            await new Promise((r) => setTimeout(r, 100));
            badge = view.containerEl.querySelector(
              mode === "preview" ? ".markdown-preview-view h2 .openlfcp-status" : ".cm-content .openlfcp-status",
            );
          }
          return badge === null
            ? null
            : {
                state: badge.dataset.state,
                label: badge.getAttribute("aria-label"),
                mark: badge.querySelectorAll(".openlfcp-status-mark path").length,
                heading: badge.closest(mode === "preview" ? "h2" : ".cm-line")?.textContent?.startsWith("Launch") ?? false,
              };
        },
        mode,
      );
    const before = await browser.executeObsidian(({ app }) => app.vault.adapter.read("share-create.md"));
    const live = await read("source");
    const reading = await read("preview");
    // Status refreshes are UI only: no write, no change to the note.
    const after = await browser.executeObsidian(async ({ app }) => {
      let writes = 0;
      const ref = app.vault.on("modify", () => writes++);
      for (let i = 0; i < 5; i++) {
        app.plugins.plugins["shared-tasks"].sections.scheduleStatus();
        await new Promise((r) => setTimeout(r, 300));
      }
      app.vault.offref(ref);
      return { writes, text: await app.vault.adapter.read("share-create.md") };
    });
    console.log(`EVIDENCE ${JSON.stringify({ id: "STATUS-BADGE", live, reading, writes: after.writes })}`);
    expect(live).not.toBeNull();
    expect(live.mark).toBe(2);
    expect(live.heading).toBe(true);
    expect(reading).toEqual(live);
    // Its server never answered: not current.
    expect(live.state).not.toBe("CURRENT");
    expect(live.label.startsWith("Shared section Launch, ")).toBe(true);
    expect(after.writes).toBe(0);
    expect(after.text).toBe(before);
  });

  it("the badge opens the details card by keyboard; Escape closes it, focus comes back (LFCP-02-059)", async () => {
    /** Opens `file` in Live Preview and its first badge's card by Enter; what the card shows. */
    const openCard = (file) =>
      browser.executeObsidian(
        async ({ app, obsidian }, file) => {
          const leaf = app.workspace.getLeaf(false);
          await leaf.openFile(app.vault.getFileByPath(file), { state: { mode: "source", source: false } });
          const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
          let badge = null;
          for (let i = 0; i < 60 && badge === null; i++) {
            await new Promise((r) => setTimeout(r, 100));
            badge = view.containerEl.querySelector(".cm-content .openlfcp-status");
          }
          badge.focus();
          badge.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
          let card = null;
          for (let i = 0; i < 60 && card === null; i++) {
            await new Promise((r) => setTimeout(r, 100));
            card = document.querySelector(".modal.openlfcp-section-card");
          }
          window.__lfcpBadge = badge;
          return card === null
            ? null
            : {
                title: card.querySelector(".modal-title")?.textContent,
                role: card.getAttribute("role"),
                text: card.textContent,
                inNote: card.closest(".workspace-leaf-content") !== null,
                images: card.querySelectorAll("img").length,
                section: [...card.querySelectorAll(".openlfcp-card-technical li")]
                  .map((li) => li.textContent)
                  .find((t) => t.startsWith("Section:")),
                buttons: [...card.querySelectorAll("button")].map((b) => b.textContent),
              };
        },
        file,
      );
    const close = async () => {
      await browser.keys("Escape");
      return browser.executeObsidian(async ({ app, obsidian }) => {
        for (let i = 0; i < 20 && document.querySelector(".modal.openlfcp-section-card") !== null; i++)
          await new Promise((r) => setTimeout(r, 50));
        const editor = app.workspace.getActiveViewOfType(obsidian.MarkdownView).editor;
        editor.setSelection({ line: 0, ch: 0 }, { line: editor.lastLine(), ch: 0 });
        return {
          open: document.querySelector(".modal.openlfcp-section-card") !== null,
          focusBack: document.activeElement === window.__lfcpBadge,
          selection: editor.getSelection(),
        };
      });
    };
    const card = await openCard("share-create.md");
    console.log(`EVIDENCE ${JSON.stringify({ id: "SECTION-CARD", card })}`);
    expect(card).not.toBeNull();
    expect(card.title).toBe('Shared section "Launch"');
    expect(card.role).toBe("dialog");
    expect(card.inNote).toBe(false);
    expect(card.text).toContain("What is shared");
    expect(card.text).toContain("You can edit this section.");
    // 060: who has access, from the validated Control state.
    expect(card.text).toContain("Identities with access");
    expect(card.text).toContain("You (owner)");
    expect(card.buttons).toEqual(["Invite collaborator…", "Resource status"]);
    const closed = await close();
    expect(closed.open).toBe(false);
    expect(closed.focusBack).toBe(true);
    expect(closed.selection).not.toContain("What is shared");
    // The same section from another note: the same section, whatever the title.
    const again = await openCard("insert-target.md");
    expect(again.section).toBe(card.section);
    await close();
  });

  it("a heading with markup: the card shows it as text, nothing runs (LFCP-02-059)", async () => {
    const note = ["## Plan <b>bold</b><img src=x onerror=\"window.__lfcpPwned=1\">", "Some text.", ""].join("\n");
    await browser.executeObsidian(
      async ({ app, obsidian }, text) => {
        await app.vault.create("markup.md", text);
        const leaf = app.workspace.getLeaf(false);
        await leaf.openFile(app.vault.getFileByPath("markup.md"), { state: { mode: "source", source: true } });
        const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
        for (let i = 0; i < 40 && view.editor.getValue() !== text; i++)
          await new Promise((r) => setTimeout(r, 50));
        view.editor.setCursor({ line: 1, ch: 0 });
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
      note,
    );
    await browser.waitUntil(
      () =>
        browser.executeObsidian(async ({ app }) =>
          (await app.vault.adapter.read("markup.md")).includes("<!-- /lfcp-section: "),
        ),
      { timeout: 15000, timeoutMsg: "the markup section shared" },
    );
    const shown = await browser.executeObsidian(async ({ app, obsidian }) => {
      const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
      let badge = null;
      for (let i = 0; i < 60 && badge === null; i++) {
        await new Promise((r) => setTimeout(r, 100));
        badge = view.containerEl.querySelector(".cm-content .openlfcp-status");
      }
      badge.click();
      let card = null;
      for (let i = 0; i < 60 && card === null; i++) {
        await new Promise((r) => setTimeout(r, 100));
        card = document.querySelector(".modal.openlfcp-section-card");
      }
      const result = {
        title: card?.querySelector(".modal-title")?.textContent,
        images: card?.querySelectorAll("img, b").length,
        pwned: window.__lfcpPwned === 1,
      };
      return result;
    });
    await browser.keys("Escape");
    await browser.waitUntil(
      () => browser.executeObsidian(() => document.querySelector(".modal.openlfcp-section-card") === null),
      { timeout: 5000, timeoutMsg: "the card closed" },
    );
    console.log(`EVIDENCE ${JSON.stringify({ id: "SECTION-CARD-MARKUP", shown })}`);
    expect(shown.title).toBe('Shared section "Plan <b>bold</b><img src=x onerror="window.__lfcpPwned=1">"');
    expect(shown.images).toBe(0);
    expect(shown.pwned).toBe(false);
  });

  it("0.1 shared tasks import into a new section and restore (LFCP-02-053/054)", async () => {
    const text = ["## Sprint", "- [ ] Import contract", "  Private child note", "- [ ] Import venue", ""].join("\n");
    await browser.executeObsidian(
      async ({ app, obsidian }, text) => {
        await app.vault.create("import.md", text);
        await app.plugins.plugins["shared-tasks"].runtime.createResource({
          name: "Legacy",
          endpoints: ["ws://127.0.0.1:9/v1/ws"],
          coordinatorUrl: "ws://127.0.0.1:9/v1/ws",
        });
        const leaf = app.workspace.getLeaf(false);
        await leaf.openFile(app.vault.getFileByPath("import.md"), { state: { mode: "source", source: true } });
        app.workspace.setActiveLeaf(leaf, { focus: true });
        const editor = app.workspace.getActiveViewOfType(obsidian.MarkdownView).editor;
        for (let i = 0; i < 40 && editor.getValue() !== text; i++) await new Promise((r) => setTimeout(r, 50));
        editor.setSelection({ line: 1, ch: 0 }, { line: 3, ch: editor.getLine(3).length });
        app.commands.executeCommandById("shared-tasks:share-selected-tasks");
        let item = null;
        for (let i = 0; i < 60 && item === null; i++) {
          await new Promise((r) => setTimeout(r, 50));
          item =
            [...document.querySelectorAll(".suggestion-item")].find((e) =>
              e.textContent.startsWith("Legacy"),
            ) ?? null;
        }
        item.click();
      },
      text,
    );
    await browser.waitUntil(
      () =>
        browser.executeObsidian(async ({ app }) =>
          (await app.vault.adapter.read("import.md")).split("lfcp-ref:").length === 3,
        ),
      { timeout: 15000, timeoutMsg: "both tasks shared the 0.1 way" },
    );
    const shared = await browser.executeObsidian(async ({ app, obsidian }) => {
      const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
      for (let i = 0; i < 40; i++) {
        if (view.editor.getValue().split("lfcp-ref:").length === 3) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      return view.editor.getValue();
    });
    const shown = await browser.executeObsidian(async ({ app, obsidian }) => {
      const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
      view.editor.setCursor({ line: 1, ch: 0 });
      app.commands.executeCommandById("shared-tasks:share-section");
      let modal = null;
      for (let i = 0; i < 60 && modal === null; i++) {
        await new Promise((r) => setTimeout(r, 50));
        modal =
          [...document.querySelectorAll(".modal-container .modal")].find((m) =>
            m.querySelector(".modal-title")?.textContent?.startsWith("Import"),
          ) ?? null;
      }
      const result = { title: modal?.querySelector(".modal-title")?.textContent, text: modal?.textContent };
      [...(modal?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "Import")?.click();
      return result;
    });
    expect(shown.title).toBe('Import "Sprint" as a new shared section');
    expect(shown.text).toContain("The existing collaborations are not changed");
    expect(shown.text).toContain("Private child note");
    const legacyId = /lfcp1:([\w-]+)#task/.exec(shared)[1];
    await browser.waitUntil(
      () =>
        browser.executeObsidian(async ({ app }) => {
          const t = await app.vault.adapter.read("import.md");
          return t.includes("<!-- /lfcp-section: ");
        }),
      { timeout: 15000, timeoutMsg: "imported into a section" },
    );
    const imported = await browser.executeObsidian(({ app }) => app.vault.adapter.read("import.md"));
    console.log(`EVIDENCE ${JSON.stringify({ id: "LEGACY-IMPORT", shared, imported })}`);
    expect(imported).not.toContain(legacyId);
    expect(imported).toContain("- [ ] Import contract");
    expect(imported).toContain("Private child note");
    // Restore: the note's view from before the import, 0.1 refs and all.
    await browser.executeObsidian(async ({ app }) => {
      app.commands.executeCommandById("shared-tasks:restore-section-import");
    });
    await browser.waitUntil(
      () =>
        browser.executeObsidian(async ({ app }, legacyId) =>
          (await app.vault.adapter.read("import.md")).includes(legacyId),
        legacyId),
      { timeout: 10000, timeoutMsg: "restored" },
    );
    const restored = await browser.executeObsidian(({ app }) => app.vault.adapter.read("import.md"));
    expect(restored).toBe(shared);
  });

  it("Repair: a broken boundary is closed where the user picks; a lost base takes the shared version (LFCP-02-062)", async () => {
    const result = await browser.executeObsidian(async ({ app, obsidian }) => {
      const source = await app.vault.adapter.read("share-create.md");
      const start = source.split("\n").find((l) => l.startsWith("<!-- lfcp-section: "));
      const end = source.split("\n").find((l) => l.startsWith("<!-- /lfcp-section: "));
      const open = async (file, text) => {
        await app.vault.create(file, text);
        const leaf = app.workspace.getLeaf(false);
        await leaf.openFile(app.vault.getFileByPath(file), { state: { mode: "source", source: true } });
        app.workspace.setActiveLeaf(leaf, { focus: true });
        const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
        for (let i = 0; i < 40 && view.editor.getValue() !== text; i++) await new Promise((r) => setTimeout(r, 50));
        app.commands.executeCommandById("shared-tasks:repair-shared-sections");
        let modal = null;
        for (let i = 0; i < 60 && modal === null; i++) {
          await new Promise((r) => setTimeout(r, 50));
          modal = document.querySelector(".modal.openlfcp-repair");
        }
        return { view, modal };
      };
      // 1. A start marker without its end.
      const broken = ["## Launch", start, "Draft the plan.", "", "## Other", "PRIVATE_REPAIR_9c: mine", ""].join("\n");
      const one = await open("repair-boundary.md", broken);
      const labels = [...one.modal.querySelectorAll(".openlfcp-repair-choice")].map((l) => l.textContent);
      one.modal.querySelector(".openlfcp-repair-choice input").click();
      [...one.modal.querySelectorAll("button")].find((b) => b.textContent === "Apply").click();
      for (let i = 0; i < 40 && !one.view.editor.getValue().includes("<!-- /lfcp-section: "); i++)
        await new Promise((r) => setTimeout(r, 50));
      const fixed = one.view.editor.getValue();
      // 2. The section copied into another note with a local edit: no base there.
      const body = source.slice(source.indexOf("## Launch"), source.indexOf(end) + end.length);
      const copy = `PRIVATE_LOST_7d: mine\n\n${body.replace("Draft the plan.", "Draft the plan, edited offline.")}\n`;
      const two = await open("repair-lost.md", copy);
      const diff = two.modal.querySelector(".openlfcp-share-content")?.textContent ?? "";
      [...two.modal.querySelectorAll("button")].find((b) => b.textContent === "Use the shared version").click();
      for (let i = 0; i < 40 && two.view.editor.getValue() === copy; i++) await new Promise((r) => setTimeout(r, 50));
      // The dropped edit is never sent: the section's other note keeps the shared text.
      await new Promise((r) => setTimeout(r, 2500));
      const origin = await app.vault.adapter.read("share-create.md");
      return { labels, fixed, diff, lost: two.view.editor.getValue(), origin };
    });
    console.log(`EVIDENCE ${JSON.stringify({ id: "SECTION-REPAIR", ...result })}`);
    expect(result.labels).toEqual([" After line 3: Draft the plan."]);
    expect(result.fixed).toMatch(/Draft the plan\.\n<!-- \/lfcp-section: [^\n]+\n\n## Other\nPRIVATE_REPAIR_9c: mine/);
    expect(result.diff).toContain("− Draft the plan, edited offline.");
    expect(result.diff).toContain("+ Draft the plan.");
    expect(result.diff).not.toContain("PRIVATE_");
    expect(result.lost.startsWith("PRIVATE_LOST_7d: mine\n\n## Launch\n")).toBe(true);
    expect(result.lost).toContain("\nDraft the plan.\n");
    expect(result.lost).not.toContain("edited offline");
    expect(result.origin).not.toContain("edited offline");
  });

  it("a heading inside blocks the share, with a reason", async () => {
    const note = ["## Launch", "- [ ] One", "### Inside", "text", ""].join("\n");
    const shown = await preview("share-nested.md", note, 0);
    expect(shown.problems).toHaveLength(1);
    expect(shown.shareDisabled).toBe(true);
  });
});
