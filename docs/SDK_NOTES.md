# @cursor/sdk backend — Phase 7 notes

Package inspected: **@cursor/sdk 1.3.1** (latest on 2026-11-05). `engines.node >= 22.13`, ESM + CJS entry points,
native binaries in optional per-platform packages (`@cursor/sdk-win32-x64`, …). Everything below comes from its
`.d.ts` files and README, not from guesses.

## API used

- `Agent.create({ apiKey, model: { id }, mode, tools, local: { cwd } })` → `SDKAgent`
- `Agent.resume(agentId, { apiKey, model, mode, tools, local: { cwd } })` continues a conversation.
  `tools` / `disallowedTools` are **not persisted**, so pass them again on every resume.
- `agent.send(text, { mode, model, onDelta })` → `Run`. `run.wait()` → `RunResult { status: finished|error|cancelled,
  result, error?, durationMs, usage }`. `run.cancel()` stops it.
- `onDelta({ update })` streams `InteractionUpdate`s: `text-delta {text}`, `thinking-delta {text}`,
  `thinking-completed {thinkingDurationMs}`, `tool-call-started|completed {callId, toolCall}`, `turn-ended {usage}`,
  plus `partial-tool-call`, `tool-call-delta`, `token-delta`, `step-*`, `summary*`, `shell-output-delta`, … (ignored).
- `toolCall` is `{ type: 'read'|'edit'|'write'|'shell'|'grep'|'glob'|'ls'|'delete'|'createPlan'|'updateTodos'|'mcp'|…,
  args, result?: { status: 'success', value } | { status: 'error', error: { message } } }`. The CLI's shape is
  `{ readToolCall: { args, result: { success } } }`, so the SDK mapper converts it (`src/sdk/sdkEvents.ts`).
- `Cursor.models.list({ apiKey })` returns the model catalog.
- Auth: `apiKey` option, else `process.env.CURSOR_API_KEY`. The worker gets the key through the environment only.

## Differences from the CLI and how the extension handles them

| CLI | SDK | Extension |
|---|---|---|
| `--mode ask` (read-only) | **no ask mode** (`AgentModeOption = "agent" \| "plan"`) | Ask = mode `agent` + `tools: ['read','grep','glob','ls','semSearch','readLints']`. The SDK enforces the allowlist; edit, write, shell, delete, task and mcp aren't offered. |
| `--force` | runs headless | Agent mode as is |
| session id from `system:init` | `agent.agentId` | stored as the tab's `sessionId`; `Agent.resume` on follow-ups |
| model optional | **model required** for local agents | tab model → `cursorAgent.defaultModel` → `"auto"` |
| `-w` worktrees | not available | worktree toggle hidden for the SDK backend |
| login (subscription) | API key, billed by usage | key in VS Code SecretStorage (`Cursor Agent: Set SDK API Key`) |

## Process model

The SDK runs in a **separate Node process** (`dist/sdk-worker.cjs`), started with the Node from `cursorAgent.sdk.nodePath`
(default `node`, needs ≥ 22.13). It runs out of process because the extension host's Node may be older, and because the
native binaries are safer there. The SDK isn't bundled: `Cursor Agent: Install SDK Backend` runs
`npm install @cursor/sdk@<pinned>` into the extension's global storage, and the worker loads it with `createRequire`
from there (`CURSOR_SDK_DIR`).

One worker per run, matching the CLI backend:
- stdin gets one JSON request, and later `{op:"cancel"}`.
- stdout carries NDJSON (`agent`, `delta`, `done`, `error`).
- Stop sends cancel, then kills the process tree after 800 ms.

Checkpoints, the Changes card, history and tabs don't depend on the backend.
