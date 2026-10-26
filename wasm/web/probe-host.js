// Loads the WASM probe (jspi or asyncify build) in the current context (page or worker) and runs its
// exports one at a time. Every printed line goes to onLine.
export async function loadProbe(mode, onLine) {
  const { default: createProbe } = await import(`./${mode}/wsdr-probe.js`);
  const mod = await createProbe({
    print: (l) => onLine({ out: l }),
    printErr: (l) => onLine({ err: l }),
  });
  let chain = Promise.resolve();
  const SIG = {
    probe_list: [],
    probe_stream: ['number', 'number', 'number', 'number', 'number', 'number'],
    probe_usb3: ['number'],
  };
  return (cmd, args = []) => {
    const run = () => mod.ccall(cmd, 'number', SIG[cmd], args, { async: true });
    const p = chain.then(run, run);
    chain = p.catch(() => {});
    return p;
  };
}

export function env() {
  return {
    usb: typeof navigator !== 'undefined' && 'usb' in navigator,
    crossOriginIsolated: self.crossOriginIsolated === true,
    jspi: typeof WebAssembly.Suspending === 'function',
    worker: typeof WorkerGlobalScope !== 'undefined',
  };
}
