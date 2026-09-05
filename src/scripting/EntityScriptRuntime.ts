import { parse } from 'acorn';
import {
  createQuickJSScriptRuntimeService,
  isQuickJSScriptRuntimeReady,
  preloadQuickJSScriptRuntime
} from './QuickJSScriptWorkerCore.ts';

type WorkerResponse = {
  requestId: number;
  ok: boolean;
  [key: string]: any;
};

/** Parse only; user source is never evaluated in the page realm. */
export function validateEntityScriptSyntax(code: string): string | null {
  try {
    parse(`function __spaceEntityScript(self, ctx) {\n${code || ''}\n}`, {
      ecmaVersion: 'latest',
      sourceType: 'script',
      allowHashBang: false
    });
    return null;
  } catch (error: any) {
    return error?.message || String(error);
  }
}

/**
 * Rewrite literal component lookups after a reusable component tree is merged
 * into an entity whose global component ids may already be occupied.
 *
 * Only `.child("literal-id")` calls are changed. Parsing first means comments,
 * log messages, state values, and dynamically computed ids are never touched.
 */
export function remapEntityScriptChildIds(
  code: string,
  ids: ReadonlyMap<string, string> | Record<string, string>
): string {
  const source = String(code || '');
  if (!source.trim()) return source;
  const lookup = ids instanceof Map ? ids : new Map(Object.entries(ids || {}));
  if (lookup.size === 0) return source;

  const prefix = 'function __spaceEntityScript(self, ctx) {\n';
  const wrapped = `${prefix}${source}\n}`;
  let ast: any;
  try {
    ast = parse(wrapped, {
      ecmaVersion: 'latest',
      sourceType: 'script',
      allowHashBang: false
    }) as any;
  } catch (_) {
    return source;
  }

  const replacements: Array<{ start: number; end: number; value: string }> = [];
  const visit = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'CallExpression' && node.callee?.type === 'MemberExpression') {
      const property = node.callee.property;
      const isChildCall = node.callee.computed
        ? property?.type === 'Literal' && property.value === 'child'
        : property?.type === 'Identifier' && property.name === 'child';
      const argument = node.arguments?.[0];
      if (isChildCall && argument?.type === 'Literal' && typeof argument.value === 'string') {
        const mapped = lookup.get(argument.value);
        const start = Number(argument.start) - prefix.length;
        const end = Number(argument.end) - prefix.length;
        if (mapped && mapped !== argument.value && start >= 0 && end <= source.length) {
          replacements.push({ start, end, value: JSON.stringify(mapped) });
        }
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'start' || key === 'end') continue;
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  };
  visit(ast);

  replacements.sort((a, b) => b.start - a.start);
  let remapped = source;
  for (const replacement of replacements) {
    remapped = `${remapped.slice(0, replacement.start)}${replacement.value}${remapped.slice(replacement.end)}`;
  }
  return remapped;
}

class EntityScriptMainThreadBroker {
  service: ReturnType<typeof createQuickJSScriptRuntimeService> | null = null;
  ready: Promise<ReturnType<typeof createQuickJSScriptRuntimeService>> | null = null;
  nextRequestId = 1;

  request(message: Record<string, any>): WorkerResponse | Promise<WorkerResponse> {
    const requestId = this.nextRequestId++;
    const request = { ...message, requestId };
    if (!this.service && isQuickJSScriptRuntimeReady()) {
      this.service = createQuickJSScriptRuntimeService();
    }
    if (this.service) return this.service.handle(request);
    if (!this.ready) {
      this.ready = preloadQuickJSScriptRuntime().then(() => {
        this.service ||= createQuickJSScriptRuntimeService();
        return this.service;
      });
    }
    return this.ready.then(service => service.handle(request));
  }
}

const broker = new EntityScriptMainThreadBroker();
let nextEntityRuntimeId = 1;

/**
 * Page-side handle for one sandboxed QuickJS Runtime. Guest code executes
 * synchronously inside QuickJS/WASM on the page thread; it never evaluates in
 * the page's JavaScript realm and only sees explicitly registered host APIs.
 */
export class EntityScriptRuntimeClient {
  readonly runtimeId: string;
  inFlight = false;
  pendingResult: any = null;
  disposed = false;
  initialized = false;
  onCompileResult: ((result: any) => void) | null = null;

  constructor() {
    this.runtimeId = `entity-runtime-${nextEntityRuntimeId++}`;
  }

  setScript(nodeId: string, code: string) {
    if (this.disposed) return { ok: false, error: 'Runtime disposed' };
    if (!this.initialized && !code.trim()) return { ok: true, nodeId };
    this.initialized = true;
    const response = broker.request({
      type: 'set-script',
      entityRuntimeId: this.runtimeId,
      nodeId,
      code
    });
    if (response instanceof Promise) {
      response.then(result => this.onCompileResult?.(result)).catch(error => {
        this.onCompileResult?.({ ok: false, nodeId, error: error.message || String(error) });
      });
      return { ok: true, pending: true };
    }
    return response;
  }

  tick(snapshot: any, hostApi: any = null): { submitted: boolean; result: any | null } {
    if (this.disposed || this.inFlight) return { submitted: false, result: null };
    this.initialized = true;
    const response = broker.request({
      type: 'tick',
      entityRuntimeId: this.runtimeId,
      snapshot,
      hostApi
    });
    if (response instanceof Promise) {
      this.inFlight = true;
      response.then(result => {
        this.pendingResult = result;
        this.inFlight = false;
      }).catch(error => {
        this.pendingResult = { ok: false, fatal: true, error: error.message || String(error) };
        this.inFlight = false;
      });
      return { submitted: true, result: null };
    }
    return { submitted: true, result: response };
  }

  takePendingResult() {
    const result = this.pendingResult;
    this.pendingResult = null;
    return result;
  }

  reset(states: Record<string, any> = {}) {
    if (this.disposed || !this.initialized) return;
    const response = broker.request({
      type: 'reset',
      entityRuntimeId: this.runtimeId,
      states
    });
    if (response instanceof Promise) response.catch(() => {});
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (!this.initialized) return;
    const response = broker.request({ type: 'dispose', entityRuntimeId: this.runtimeId });
    if (response instanceof Promise) response.catch(() => {});
  }
}
