/// <reference lib="webworker" />
const workerScope = self as unknown as DedicatedWorkerGlobalScope;
const queuedMessages: any[] = [];
let messageListener: ((message: any) => void) | null = null;
let startupError: string | null = null;

const respondWithStartupError = (message: any) => workerScope.postMessage({
  requestId: message?.requestId,
  ok: false,
  fatal: true,
  error: startupError
});

workerScope.addEventListener('message', event => {
  if (startupError) respondWithStartupError(event.data);
  else if (messageListener) messageListener(event.data);
  else queuedMessages.push(event.data);
});

import('./QuickJSScriptWorkerCore.ts').then(({ startQuickJSScriptWorker }) => {
  startQuickJSScriptWorker({
    postMessage: message => workerScope.postMessage(message),
    onMessage: listener => {
      messageListener = listener;
      for (const message of queuedMessages.splice(0)) listener(message);
    }
  });
}).catch(error => {
  startupError = `Entity script Worker failed to initialize: ${error?.message || String(error)}`;
  for (const message of queuedMessages.splice(0)) respondWithStartupError(message);
});
