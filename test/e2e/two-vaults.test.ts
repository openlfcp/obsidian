// LFCP-066: the two-vault product E2E. Two clean vaults on two devices
// (separate apps, secretStorage, IndexedDB installs, Principals), the real
// reference server binary, real WebSockets, and the plugin driven only
// through its commands and vault events, as a user would. Steps run in
// order and share state. Skipped without cargo or ../server unless
// LFCP_REQUIRE_LIVE=1 (then an error).

import { type ResourceId, toBase64url, toHex } from "@openlfcp/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type E2EServer, serverBinary, startServer } from "../support/e2e-server";
import { E2EVault, until } from "../support/e2e-vault";

const binary = serverBinary();
const live = "bin" in binary;

// Distinctive strings: private surrounding text, the Task plaintext, note paths.
const PRIVATE_A = "PRIVATE-A-7f3e19";
const PRIVATE_B = "PRIVATE-B-9c2d44";
const TASK = "Prepare API contract TASKMARK-5521";
const TASK_BETA = "Book venue TASKMARK-8810";
const PATH_A = "Private/a-notes-pathmark-4471.md";
const PATH_A_DASH = "Dashboard-pathmark-3302.md";
const PATH_B = "Work/b-notes-pathmark-6650.md";
const MARKERS = [PRIVATE_A, PRIVATE_B, "TASKMARK", "pathmark"];

const NOTE_A = `# Private A

This paragraph belongs only to Vault A. ${PRIVATE_A}

- [ ] ${TASK}
- [ ] ${TASK_BETA}

More private A text.
`;
const NOTE_B = `# Private B

This text is unique to B. ${PRIVATE_B}

Some unrelated notes.

- [ ] A local task of B that is never shared

`;

let server: E2EServer;
let A: E2EVault;
let B: E2EVault;
let alpha: ResourceId;
let beta: ResourceId;
let taskId: string;

beforeAll(async () => {
  if (!live) return;
  server = await startServer(binary.bin);
  A = await E2EVault.open("A");
  B = await E2EVault.open("B");
}, 300_000);

afterAll(async () => {
  await A?.close();
  await B?.close();
  await server?.stop();
});

const pick = (label: string) => label;
const refOf = (R: ResourceId) => `lfcp1:${toBase64url(R)}#task:`;
const sharedTask = async (v: E2EVault, R: ResourceId, id: string) =>
  (await v.runtime.profileOf(R)).replica.task(id);
const pendingOutbound = async (v: E2EVault) =>
  (await v.runtime.storage?.outbound.list())?.length ?? 0;

describe.skipIf(!live)("two vaults, one real server (LFCP-066)", () => {
  it("1. two clean vaults have independent Principals", () => {
    const a = A.runtime.status;
    const b = B.runtime.status;
    if (a.kind !== "ready" || b.kind !== "ready") throw new Error("not ready");
    expect(toHex(a.principalId)).not.toBe(toHex(b.principalId));
  });

  it("2. A creates and hosts two collaborations and shares two tasks of one note (Test B)", async () => {
    await A.write(PATH_A, NOTE_A);
    const created = await A.command("create-collaboration", ["Project Alpha", server.url]);
    expect(created).toContain("created and hosted");
    await A.command("create-collaboration", ["Project Beta", server.url]);
    const list = await A.runtime.registry();
    alpha = list.find((e) => e.localName === "Project Alpha")?.resourceId as ResourceId;
    beta = list.find((e) => e.localName === "Project Beta")?.resourceId as ResourceId;

    // Child-line (the default) for Alpha, inline for Beta.
    A.focus(PATH_A, TASK);
    expect(await A.command("share-task-under-cursor", [pick("Project Alpha")])).toContain(
      "task shared",
    );
    A.plugin.settings.refPlacement = "inline";
    A.focus(PATH_A, TASK_BETA);
    expect(await A.command("share-task-under-cursor", [pick("Project Beta")])).toContain(
      "task shared",
    );
    A.plugin.settings.refPlacement = "child-line";

    const note = A.read(PATH_A);
    taskId = (new RegExp(`${refOf(alpha)}([0-9a-f-]+)`).exec(note) as RegExpExecArray)[1] as string;
    expect(note).toContain(`- [ ] ${TASK}\n  <!-- lfcp-ref: ${refOf(alpha)}${taskId} -->\n`);
    expect(note).toMatch(
      new RegExp(`- \\[ \\] ${TASK_BETA} <!-- lfcp-ref: ${refOf(beta)}[0-9a-f-]+ -->\\n`),
    );
    expect(note.replace(/ ?\n? *<!-- lfcp-ref: [^>]+ -->/g, "")).toBe(NOTE_A);
    await until("A's units on the server", async () =>
      (await pendingOutbound(A)) === 0 ? true : undefined,
    );
  }, 120_000);

  it("3. A invites B to both; B joins through the real claim flow", async () => {
    for (const name of ["Project Alpha", "Project Beta"]) {
      await A.command("invite-collaborator", [pick(name), pick("Read + write")]);
      const link = A.prompter.invitations.at(-1)?.reveal() as string;
      expect(link).toMatch(/^lfcp:\/\/join\//);
      const joined = await B.command("join-collaboration", [link, `${name} at B`]);
      expect(joined).toContain("joined");
      expect(joined).toContain("read and write");
    }
    // B decrypts the shared Task (its plaintext is exactly A's title).
    const seen = await until(
      "the task on B",
      async () => (await sharedTask(B, alpha, taskId))?.task,
    );
    expect(seen.title).toBe(TASK);
  }, 120_000);

  it("4. B places the same Tasks in its own note: Alpha inline, Beta child-line", async () => {
    await B.write(PATH_B, NOTE_B);
    B.plugin.settings.refPlacement = "inline";
    B.focus(PATH_B, "Some unrelated notes.");
    await B.command("insert-shared-object", [pick("Project Alpha at B"), pick(TASK)]);
    B.plugin.settings.refPlacement = "child-line";
    await until("Beta's task on B", async () =>
      (await B.runtime.profileOf(beta)).replica.objectIds().length > 0 ? true : undefined,
    );
    B.focus(PATH_B, "- [ ] A local task of B");
    await B.command("insert-shared-object", [pick("Project Beta at B"), pick(TASK_BETA)]);
    const note = B.read(PATH_B);
    expect(note).toContain(`- [ ] ${TASK} <!-- lfcp-ref: ${refOf(alpha)}${taskId} -->`);
    expect(note).toMatch(new RegExp(`- \\[ \\] ${TASK_BETA}\\n  <!-- lfcp-ref: ${refOf(beta)}`));
    expect(note).toContain(PRIVATE_B);
    // A also projects the Alpha task a second time, in a dashboard note.
    await A.write(PATH_A_DASH, "# Dashboard\n\n");
    A.focus(PATH_A_DASH, "# Dashboard");
    await A.command("insert-shared-object", [pick("Project Alpha"), pick(TASK)]);
    expect(A.read(PATH_A_DASH)).toContain(
      `- [ ] ${TASK}\n  <!-- lfcp-ref: ${refOf(alpha)}${taskId} -->`,
    );
  }, 120_000);

  it("5. B completes the Task; both of A's projections update, private text exact", async () => {
    const before = A.read(PATH_A);
    await B.editLine(PATH_B, `- [ ] ${TASK}`, `- [x] ${TASK}`);
    await until("the completion on A's notes", () =>
      A.read(PATH_A).includes(`- [x] ${TASK}`) && A.read(PATH_A_DASH).includes(`- [x] ${TASK}`)
        ? true
        : undefined,
    );
    expect(A.read(PATH_A)).toBe(before.replace(`- [ ] ${TASK}`, `- [x] ${TASK}`));
    // Placements stayed: child-line on A, inline on B.
    expect(A.read(PATH_A)).toContain(`- [x] ${TASK}\n  <!-- lfcp-ref:`);
    expect(B.read(PATH_B)).toContain(`- [x] ${TASK} <!-- lfcp-ref:`);
  }, 60_000);

  it("6. offline: independent edits on both sides converge after reconnect (Have anti-entropy)", async () => {
    B.network.offline = true;
    await A.editLine(PATH_A, `- [x] ${TASK}`, `- [x] ${TASK} v2`);
    await until("A's title change on the server", async () =>
      (await pendingOutbound(A)) === 0 ? true : undefined,
    );
    await B.editLine(PATH_B, `- [x] ${TASK} <!--`, `- [x] ${TASK} 📅 2026-10-20 <!--`);
    expect((await sharedTask(B, alpha, taskId))?.task?.title).toBe(TASK); // A's edit has not reached B
    B.network.offline = false;
    await until(
      "both edits on both vaults",
      () =>
        A.read(PATH_A).includes(`- [x] ${TASK} v2 📅 2026-10-20`) &&
        B.read(PATH_B).includes(`- [x] ${TASK} v2 📅 2026-10-20 <!--`)
          ? true
          : undefined,
      60_000,
    );
    const rootA = JSON.stringify((await A.runtime.profileOf(alpha)).replica.root());
    const rootB = JSON.stringify((await B.runtime.profileOf(alpha)).replica.root());
    expect(rootA).toBe(rootB);
  }, 120_000);

  it("7. a same-field conflict is surfaced on both vaults and resolved causally from one", async () => {
    A.network.offline = true;
    B.network.offline = true;
    await A.editLine(PATH_A, `- [x] ${TASK} v2`, `- [/] ${TASK} v2`);
    await B.editLine(PATH_B, `- [x] ${TASK} v2`, `- [-] ${TASK} v2`);
    A.network.offline = false;
    B.network.offline = false;
    for (const v of [A, B])
      await until(
        `the conflict on ${v.name}`,
        async () =>
          (await sharedTask(v, alpha, taskId))?.fields.status.conflicted ? true : undefined,
        60_000,
      );
    for (const v of [A, B]) {
      await v.settle();
      expect(v.host.statusBar[0]?.text).toMatch(/1 shared task has a conflict/);
      expect((await sharedTask(v, alpha, taskId))?.fields.status.values).toEqual([
        "cancelled",
        "in_progress",
      ]);
    }
    expect(A.read(PATH_A)).not.toMatch(/<{7}|={7}|>{7}/);
    // B resolves it through the conflict command: a new causal change.
    B.focus(PATH_B, TASK);
    expect(
      await B.command("resolve-shared-conflict", [pick("status"), pick("cancelled")]),
    ).toContain("resolved");
    for (const v of [A, B])
      await until(
        `the resolution on ${v.name}`,
        async () => {
          const t = await sharedTask(v, alpha, taskId);
          return t?.fields.status.conflicted === false && t.task?.status === "cancelled"
            ? true
            : undefined;
        },
        60_000,
      );
    await until("both notes show the resolution", () =>
      A.read(PATH_A).includes(`- [-] ${TASK} v2`) &&
      A.read(PATH_A_DASH).includes(`- [-] ${TASK} v2`) &&
      B.read(PATH_B).includes(`- [-] ${TASK} v2`)
        ? true
        : undefined,
    );
    await A.settle();
    await B.settle();
    expect(A.host.statusBar[0]?.text).toBe("");
    expect(B.host.statusBar[0]?.text).toBe("");
  }, 180_000);

  it("8. detaching a projection keeps the Shared Task and sends nothing more for it (Test C)", async () => {
    A.focus(PATH_A_DASH, TASK);
    expect(await A.command("detach-shared-task")).toContain("no longer shared");
    expect(A.read(PATH_A_DASH)).toBe(`# Dashboard\n- [-] ${TASK} v2 📅 2026-10-20\n\n`);
    const status = A.runtime.status;
    if (status.kind !== "ready") throw new Error("not ready");
    const mine = async () =>
      (
        await A.runtime.storage?.dataUnits.range(
          alpha,
          status.principalId,
          1n as never,
          (2n ** 64n - 1n) as never,
        )
      )?.length;
    const units = await mine();
    await A.editLine(PATH_A_DASH, `- [-] ${TASK} v2`, `- [ ] Something else entirely`);
    expect(await mine()).toBe(units);
    // The other projections keep syncing; the detached line is never bound again.
    await B.editLine(PATH_B, `- [-] ${TASK} v2`, `- [-] ${TASK} v3`);
    await until("B's rename on A's note", () =>
      A.read(PATH_A).includes(`${TASK} v3`) ? true : undefined,
    );
    expect(A.read(PATH_A_DASH)).toBe(
      "# Dashboard\n- [ ] Something else entirely 📅 2026-10-20\n\n",
    );
    expect((await sharedTask(A, alpha, taskId))?.task?.lifecycle).toBe("active");
  }, 120_000);

  it("9, 10. private Markdown, note paths and Task plaintext never reach the wire, the server or the other vault", async () => {
    const enc = (t: string) => Buffer.from(t, "utf8");
    const leaks = (bytes: Uint8Array) => MARKERS.filter((m) => Buffer.from(bytes).includes(enc(m)));
    for (const v of [A, B]) {
      expect(v.network.frames.length).toBeGreaterThan(10);
      for (const f of v.network.frames)
        expect(leaks(f.bytes), `${v.name} ${f.dir} frame`).toEqual([]);
      // Local names of collaborations are labels on this device only.
      for (const f of v.network.frames)
        expect(Buffer.from(f.bytes).includes(enc("Project Alpha")), `${v.name} frame`).toBe(false);
    }
    const stored = server.stored();
    expect(stored.length).toBeGreaterThan(0);
    for (const { file, bytes } of stored) expect(leaks(bytes), file).toEqual([]);
    expect(leaks(enc(server.log()))).toEqual([]);
    for (const text of A.app.vault.files.values()) expect(text).not.toContain(PRIVATE_B);
    for (const text of B.app.vault.files.values()) {
      expect(text).not.toContain(PRIVATE_A);
      expect(text).not.toContain("a-notes-pathmark");
    }
    // B holds the decrypted Task semantics only: the title and fields, nothing of A's note.
    expect(JSON.stringify((await B.runtime.profileOf(alpha)).replica.root())).not.toContain(
      PRIVATE_A,
    );
  });
});
