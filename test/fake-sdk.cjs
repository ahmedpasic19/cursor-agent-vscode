/**
 * Fake @cursor/sdk for tests: the subset the worker uses, with the real shapes
 * (docs/SDK_NOTES.md). Installed by tests into <tmp>/node_modules/@cursor/sdk/index.js.
 *
 * Behaviour is driven by the prompt:
 *   "slow"         → 150 ms between deltas (for cancel tests)
 *   "edit:<file>"  → writes <file> in local.cwd and reports an edit tool call
 *   "fail"         → run finishes with status "error"
 * apiKey "bad" → AuthenticationError at create/resume; agentId "missing" → AgentNotFoundError.
 * Every create/resume is appended to FAKE_SDK_RECORD (key presence only, never the key).
 */
const { appendFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { join, dirname } = require('node:path');

class CursorSdkError extends Error {}
class AuthenticationError extends CursorSdkError {}
class AgentNotFoundError extends CursorSdkError {}

let n = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function record(entry) {
  if (process.env.FAKE_SDK_RECORD) appendFileSync(process.env.FAKE_SDK_RECORD, JSON.stringify(entry) + '\n');
}

function makeAgent(agentId, opts) {
  return {
    agentId,
    model: opts.model,
    close() {},
    async send(text, sendOpts) {
      record({ op: 'send', agentId, text, mode: sendOpts.mode, model: sendOpts.model });
      let cancelled = false;
      let resolveWait;
      const waitP = new Promise((r) => (resolveWait = r));
      const delay = text.includes('slow') ? 150 : 2;
      const emit = (update) => sendOpts.onDelta && sendOpts.onDelta({ update });
      (async () => {
        const t0 = Date.now();
        emit({ type: 'step-started', stepId: 1 });
        emit({ type: 'thinking-delta', text: 'Considering ' });
        await sleep(delay);
        emit({ type: 'thinking-delta', text: 'the request.' });
        emit({ type: 'thinking-completed', thinkingDurationMs: 1200 });
        const readPath = join(opts.local.cwd, 'README.md');
        emit({ type: 'tool-call-started', callId: 'c1', modelCallId: 'm1', toolCall: { type: 'read', args: { path: readPath } } });
        await sleep(delay);
        emit({ type: 'partial-tool-call', callId: 'c1', toolCall: { type: 'read', args: { path: readPath } } });
        emit({
          type: 'tool-call-completed',
          callId: 'c1',
          modelCallId: 'm1',
          toolCall: { type: 'read', args: { path: readPath }, result: { status: 'success', value: { content: '# demo\n', totalLines: 1 } } },
        });
        const edit = /edit:(\S+)/.exec(text);
        if (edit) {
          const p = join(opts.local.cwd, edit[1]);
          mkdirSync(dirname(p), { recursive: true });
          writeFileSync(p, 'written by the fake SDK\n');
          emit({ type: 'tool-call-started', callId: 'c2', modelCallId: 'm2', toolCall: { type: 'edit', args: { path: p } } });
          emit({
            type: 'tool-call-completed',
            callId: 'c2',
            modelCallId: 'm2',
            toolCall: { type: 'edit', args: { path: p }, result: { status: 'success', value: { linesAdded: 1, linesRemoved: 0, diffString: '+written by the fake SDK' } } },
          });
        }
        const reply = `Hello from the fake SDK (mode=${sendOpts.mode}, tools=${opts.tools ? opts.tools.join('|') : 'default'}).`;
        for (const chunk of reply.match(/.{1,12}/g)) {
          if (cancelled) break;
          emit({ type: 'text-delta', text: chunk });
          emit({ type: 'token-delta', tokens: 3 });
          await sleep(delay);
        }
        emit({ type: 'turn-ended', usage: { inputTokens: 1000, outputTokens: 42, cacheReadTokens: 500, cacheWriteTokens: 0 } });
        const usage = { inputTokens: 1000, outputTokens: 42, cacheReadTokens: 500, cacheWriteTokens: 0, totalTokens: 1542 };
        if (cancelled) resolveWait({ id: 'run-1', status: 'cancelled', durationMs: Date.now() - t0 });
        else if (text.includes('fail')) resolveWait({ id: 'run-1', status: 'error', error: { message: 'model exploded', code: 'internal' }, durationMs: Date.now() - t0, usage });
        else resolveWait({ id: 'run-1', status: 'finished', result: reply, durationMs: Date.now() - t0, usage });
      })();
      return {
        id: 'run-1',
        agentId,
        wait: () => waitP,
        async cancel() {
          cancelled = true;
        },
      };
    },
  };
}

const Agent = {
  async create(opts) {
    record({ op: 'create', hasKey: !!opts.apiKey, model: opts.model, mode: opts.mode, tools: opts.tools, cwd: opts.local && opts.local.cwd });
    if (opts.apiKey === 'bad') throw new AuthenticationError('Invalid API key');
    if (!opts.model || !opts.model.id) throw new CursorSdkError('model is required for local agents');
    return makeAgent(`agent-${process.pid}-${++n}`, opts);
  },
  async resume(agentId, opts) {
    record({ op: 'resume', agentId, hasKey: !!opts.apiKey, model: opts.model, mode: opts.mode, tools: opts.tools });
    if (opts.apiKey === 'bad') throw new AuthenticationError('Invalid API key');
    if (agentId === 'missing') throw new AgentNotFoundError(`No agent ${agentId}`);
    return makeAgent(agentId, opts);
  },
};

const Cursor = {
  models: {
    async list(o) {
      if (o && o.apiKey === 'bad') throw new AuthenticationError('Invalid API key');
      return [
        { id: 'auto', displayName: 'Auto' },
        { id: 'composer-2.5', displayName: 'Composer 2.5' },
      ];
    },
  },
};

module.exports = { Agent, Cursor, AuthenticationError, AgentNotFoundError, CursorSdkError };
