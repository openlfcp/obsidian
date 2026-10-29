// Obsidian runs the plugin in a browser window, where `window` (and
// Obsidian's `activeWindow`) always exist; the adapter uses them for timers,
// the navigator and the clipboard (popout-window friendly, as Obsidian's
// guidelines ask). The unit tests run in Node: this gives them the same
// globals, pointing at Node's global object.
const g = globalThis as Record<string, unknown>;
g.window ??= globalThis;
g.activeWindow ??= globalThis;
// Obsidian's `activeDocument`: the DOM test environment's document, where there is one.
g.activeDocument ??= g.document;

// Obsidian's DOM helpers (createEl/createDiv/createSpan on nodes and on a
// window, `node.win`, `node.instanceOf`) for the happy-dom environment. Obsidian
// adds them to the browser's prototypes; the DOM test environment has none.
type Info = {
  cls?: string | string[];
  text?: string;
  attr?: Record<string, string | number | boolean | null>;
  title?: string;
  type?: string;
  placeholder?: string;
  value?: string;
  href?: string;
};
if (typeof Node !== "undefined" && typeof document !== "undefined") {
  const make = (doc: Document, tag: string, o?: Info | string): HTMLElement => {
    const info: Info = typeof o === "string" ? { cls: o } : (o ?? {});
    const el = doc.createElement(tag);
    if (info.cls !== undefined)
      el.className = Array.isArray(info.cls) ? info.cls.join(" ") : info.cls;
    if (info.text !== undefined) el.textContent = info.text;
    if (info.title !== undefined) el.title = info.title;
    for (const [k, v] of Object.entries(info.attr ?? {}))
      if (v !== null) el.setAttribute(k, String(v));
    for (const k of ["type", "placeholder", "value", "href"] as const)
      if (info[k] !== undefined) el.setAttribute(k, info[k]);
    return el;
  };
  const docOf = (n: Node): Document =>
    n.nodeType === 9 ? (n as Document) : (n.ownerDocument ?? document);
  Object.defineProperty(Node.prototype, "instanceOf", {
    configurable: true,
    value(this: Node, type: new () => unknown) {
      return this instanceof type;
    },
  });
  const onNode = (tag?: string) =>
    function (
      this: Node,
      a: string | Info | undefined,
      b?: Info | string,
      cb?: (el: HTMLElement) => void,
    ) {
      const t = tag ?? (a as string);
      const el = make(docOf(this), t, tag === undefined ? b : (a as Info | string | undefined));
      this.appendChild(el);
      (tag === undefined ? cb : (b as ((el: HTMLElement) => void) | undefined))?.(el);
      return el;
    };
  Object.defineProperty(Node.prototype, "createEl", { configurable: true, value: onNode() });
  Object.defineProperty(Node.prototype, "createDiv", { configurable: true, value: onNode("div") });
  Object.defineProperty(Node.prototype, "createSpan", {
    configurable: true,
    value: onNode("span"),
  });
  // On a window the element is made in that window's document and not appended.
  const onWindow = (tag?: string) =>
    function (
      this: Window,
      a: string | Info | undefined,
      b?: Info | string,
      cb?: (el: HTMLElement) => void,
    ) {
      const t = tag ?? (a as string);
      const el = make(this.document, t, tag === undefined ? b : (a as Info | string | undefined));
      (tag === undefined ? cb : (b as ((el: HTMLElement) => void) | undefined))?.(el);
      return el;
    };
  // A popout's window is another object: it gets the helpers when `node.win` hands it out.
  const withHelpers = (w: object): object => {
    if ("createSpan" in w) return w;
    Object.defineProperty(w, "createEl", { configurable: true, writable: true, value: onWindow() });
    Object.defineProperty(w, "createDiv", {
      configurable: true,
      writable: true,
      value: onWindow("div"),
    });
    Object.defineProperty(w, "createSpan", {
      configurable: true,
      writable: true,
      value: onWindow("span"),
    });
    return w;
  };
  withHelpers(globalThis);
  Object.defineProperty(Node.prototype, "win", {
    configurable: true,
    get(this: Node) {
      return withHelpers(docOf(this).defaultView ?? globalThis);
    },
  });
}
