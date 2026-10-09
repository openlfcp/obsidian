// The live tests' server in a gate (LFCP_REQUIRE_LIVE=1): the binary named
// in LFCP_SERVER_BIN, the build at server.lock. Plain JavaScript, so that
// orphan-parent.mjs runs the helpers that import it under Node without a
// build step.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The server.lock commit, for the error messages. */
function lockedServer() {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const lock = JSON.parse(readFileSync(resolve(here, "../../server.lock"), "utf8"));
    return typeof lock.commit === "string" ? lock.commit.slice(0, 7) : "unknown";
  } catch {
    return "unknown";
  }
}

/** LFCP_REQUIRE_LIVE=1: LFCP_SERVER_BIN is set and exists, else a clear error. */
export function requireExplicitServer() {
  const bin = process.env.LFCP_SERVER_BIN;
  if (bin === undefined || bin === "")
    throw new Error(
      `LFCP_REQUIRE_LIVE=1 needs LFCP_SERVER_BIN: the lfcp-server built at server.lock (${lockedServer()}). A default location may hold another server's build, so none is used.`,
    );
  if (!existsSync(bin))
    throw new Error(`LFCP_REQUIRE_LIVE=1 but LFCP_SERVER_BIN does not exist: ${bin}`);
  return bin;
}
