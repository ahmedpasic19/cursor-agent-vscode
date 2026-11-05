import type { WebviewMessage } from '../../src/shared/protocol';

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(s: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const api: VsCodeApi =
  typeof acquireVsCodeApi === 'function'
    ? acquireVsCodeApi()
    : { postMessage: (m) => console.log('[postMessage]', m), getState: () => undefined, setState: () => {} };

export function send(msg: WebviewMessage): void {
  api.postMessage(msg);
}

export const vscodeState = {
  get: <T,>(): T | undefined => api.getState() as T | undefined,
  set: (s: unknown) => api.setState(s),
};
