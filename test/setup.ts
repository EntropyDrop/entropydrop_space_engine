import { Worker as NodeWorker } from 'node:worker_threads';

class TestWebWorker {
  worker: NodeWorker;
  onmessage: ((event: { data: any }) => void) | null = null;
  onerror: ((event: { message: string; error: Error }) => void) | null = null;

  constructor(url: URL | string, options: any = {}) {
    const workerUrl = new URL(String(url));
    if (workerUrl.pathname.endsWith('/EntityScriptWorker.ts')) {
      workerUrl.pathname = workerUrl.pathname.replace(/EntityScriptWorker\.ts$/, 'EntityScriptWorker.node.ts');
    }
    const workerEnv = { ...process.env };
    delete workerEnv.NODE_TEST_CONTEXT;
    this.worker = new NodeWorker(workerUrl, {
      name: options.name,
      execArgv: [],
      env: workerEnv
    });
    this.worker.on('message', data => this.onmessage?.({ data }));
    this.worker.on('error', (error: Error) => this.onerror?.({ message: error.message, error }));
    this.worker.unref();
  }

  postMessage(message: any) {
    this.worker.postMessage(message);
  }

  terminate() {
    void this.worker.terminate();
  }
}

Object.defineProperty(globalThis, 'Worker', {
  configurable: true,
  writable: true,
  value: TestWebWorker
});
Object.defineProperty(globalThis, '__SPACE_SCRIPT_SYNC__', {
  configurable: true,
  writable: false,
  value: true
});

if (typeof (globalThis as any).ProgressEvent === 'undefined') {
  (globalThis as any).ProgressEvent = class ProgressEvent extends Event {};
}

// Production initializes QuickJS on the first programmable entity so Space's
// entry path never waits for WASM. Tests preload once to keep synchronous unit
// assertions deterministic after importing Contraption.
const { preloadQuickJSScriptRuntime } = await import('../src/scripting/QuickJSScriptWorkerCore.ts');
await preloadQuickJSScriptRuntime();
