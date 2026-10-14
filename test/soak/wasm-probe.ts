// Every WebAssembly instance of a soak peer (the profile's Automerge, the
// crypto), recorded before any module loads, so that a sample can say how
// much of the process's memory is WASM linear memory (soak finding #7).

type Probed = { readonly exports: { readonly memory?: WebAssembly.Memory } };
const instances: Probed[] = [];
(globalThis as { __soakWasm?: Probed[] }).__soakWasm = instances;
const Original = WebAssembly.Instance;
WebAssembly.Instance = new Proxy(Original, {
  construct(target, args) {
    const instance = Reflect.construct(target, args) as Probed;
    instances.push(instance);
    return instance;
  },
});
