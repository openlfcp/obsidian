// Reads openlfcp/spec files at the commit pinned in spec.lock, as sdk-ts and
// sdk-rs do: `git -C <spec checkout> show <commit>:<path>`, after checking
// that the locked tag still resolves to the locked commit. The checkout is
// $LFCP_SPEC_DIR, or ../spec next to this repository. Test-only Node code.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export interface SpecLock {
  readonly repository: string;
  readonly tag: string;
  readonly commit: string;
}

function git(dir: string, args: string[]): string {
  try {
    return execFileSync("git", ["-C", dir, ...args], { stdio: "pipe", encoding: "utf8" });
  } catch (e) {
    const err = e as { stderr?: unknown; message?: string };
    throw new Error(
      `git ${args.join(" ")} failed in ${dir}: ${String(err.stderr ?? err.message).trim()}`,
    );
  }
}

export function readLock(): SpecLock {
  const lock = JSON.parse(readFileSync(resolve(ROOT, "spec.lock"), "utf8")) as SpecLock;
  if (!/^[0-9a-f]{40}$/.test(lock.commit))
    throw new Error("spec.lock must pin a full 40-hex commit");
  return lock;
}

/** The spec checkout, verified against spec.lock. */
export function openSpec(): { lock: SpecLock; read: (path: string) => string } {
  const lock = readLock();
  const dir = resolve(ROOT, process.env.LFCP_SPEC_DIR ?? "../spec");
  let resolved: string;
  try {
    resolved = git(dir, [
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/tags/${lock.tag}^{commit}`,
    ]).trim();
  } catch (e) {
    throw new Error(
      `spec.lock pins ${lock.tag}, which does not resolve in ${dir}: ${(e as Error).message}. ` +
        "Clone openlfcp/spec there with its tags, or set LFCP_SPEC_DIR.",
    );
  }
  if (resolved !== lock.commit) {
    throw new Error(
      `spec tag ${lock.tag} resolves to ${resolved}, but spec.lock pins ${lock.commit}`,
    );
  }
  return { lock, read: (path) => git(dir, ["show", `${lock.commit}:${path}`]) };
}

/** A spec file at the locked commit, parsed as JSON. */
export function readSpecJson(path: string): unknown {
  return JSON.parse(openSpec().read(path));
}
