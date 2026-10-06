// The line the "Create collaboration" flow shows under the server field
// when the server is the OpenLFCP project's own (sync.openlfcp.org): who
// runs it, what it sees, and where its privacy note and terms are. Pure:
// no logging, no network.

/** A short, non-blocking note with links, shown next to a field. */
export interface Hint {
  readonly text: string;
  readonly links: readonly { readonly label: string; readonly url: string }[];
}

/** The host of the project server ({@link PROJECT_SERVER} in settings). */
export const PROJECT_SERVER_HOST = "sync.openlfcp.org";

const DOCS = "https://github.com/openlfcp/.github/blob/main/docs/operations";

/** What the project server's users are told. */
export const PROJECT_SERVER_HINT: Hint = {
  text: "Hosted by the OpenLFCP project (beta). The server sees metadata, not your tasks.",
  links: [
    { label: "Privacy note", url: `${DOCS}/sync-server-privacy.md` },
    { label: "Terms", url: `${DOCS}/sync-server-terms.md` },
  ],
};

/** {@link PROJECT_SERVER_HINT} for a ws:// or wss:// URL of the project server, else null. */
export function serverHint(server: string): Hint | null {
  let url: URL;
  try {
    url = new URL(server.trim());
  } catch {
    return null;
  }
  const websocket = url.protocol === "wss:" || url.protocol === "ws:";
  return websocket && url.hostname.toLowerCase() === PROJECT_SERVER_HOST
    ? PROJECT_SERVER_HINT
    : null;
}
