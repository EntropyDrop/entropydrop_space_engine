import { parentPort } from 'node:worker_threads';
import { startQuickJSScriptWorker } from './QuickJSScriptWorkerCore.ts';

if (!parentPort) throw new Error('EntityScriptWorker.node requires a worker_threads parent port');

startQuickJSScriptWorker({
  postMessage: message => parentPort.postMessage(message),
  onMessage: listener => parentPort.on('message', listener)
});

