# Ask → Agent in the same CLI session

Verified on 2026-11-06 with CLI 2026.11.05-86047df (throwaway chat in a scratch folder).

## Problem

The CLI keeps a chat's mode across `--resume`. `--mode` only accepts `plan|ask`, so there is no
`--mode agent`. Today we prefix the prompt with `SWITCH_TO_AGENT_PREFIX`. From Plan mode the agent
then calls `switchModeToolCall`. From **Ask** mode it refuses ("I'm still in Ask mode… Switch to
Agent mode"), because Ask mode doesn't let it switch.

`/ask` and Shift+Tab only work in the interactive TUI. In `-p` mode, `/ask` is sent to the model as
plain text and the mode does not change (tested).

## Where the mode is stored

```
~/.cursor/chats/<hash>/<sessionId>/store.db      (SQLite)
  table meta (key TEXT PRIMARY KEY, value TEXT)
  key '0' → hex-encoded JSON:
  {"agentId":"<sessionId>","latestRootBlobId":"…","name":"…","createdAt":…,
   "mode":"default","isRunEverything":true,"blobEncryptionKey":"…"}
```

Mode values the CLI writes:

| UI mode | stored `mode` |
|---------|---------------|
| Agent   | `default`     |
| Ask     | `search`      |
| Plan    | `plan`        |

`<hash>` is a per-workspace folder. Don't compute it: find the session folder with
`~/.cursor/chats/*/<sessionId>/store.db` (one directory level).

## Solution (recommended): rewrite `mode` to `default` before resuming

When a run is `mode === 'agent'` and the tab's `sessionMode` is `ask` (or `plan`):

1. Find `~/.cursor/chats/*/<sessionId>/store.db`.
2. Read `meta` key `'0'`, hex-decode, then `JSON.parse`. Set `mode = 'default'`, re-encode and `UPDATE`.
   Change only that one field. Don't touch `blobEncryptionKey` or anything else.
3. Resume as usual: `--resume <id> --force`, with **no** switch prefix.

Results:

- Ask turn (`--mode ask`), stored `search`. Flip to `default`, then a resume with `--force`: the first tool
  call was `editToolCall` → `success`. No `switchModeToolCall` and no failed edit first.
- `session_id` stays the same on every run.
- After the agent turn the CLI still stores `default`, so the next turn stays in Agent.
- This also fixes the Plan → Agent "one failed edit before switching" quirk, because the run starts in Agent.

Notes for implementation:

- Use `node:sqlite` (`DatabaseSync`, Node ≥ 22.5; it logs an ExperimentalWarning). The extension
  host's Node in VS Code 1.100+ may not have it. If not, run the change in a short child process
  with the same Node the CLI uses (`cliLocator`), or bundle a small SQLite lib.
- Do it only while no run is active on that session (the CLI holds the DB during a run).
- Wrap it in a try/catch. If the store is missing or the format changed, fall back (below) and log it.
- Only the SDK backend has no `store.db`. Skip this there.

## Fallback (no DB write): `--mode plan` + switch prefix

If the store can't be edited, resume the Ask chat with `--mode plan --force` and the existing
`SWITCH_TO_AGENT_PREFIX`. Plan mode has the SwitchMode tool:

- Run trace: `switchModeToolCall` (plan→agent, auto-approved `switchModeRequestQuery`), then
  `editToolCall` succeeds. Same `session_id`.
- **Catch:** the in-run switch is not saved. The stored mode stays `plan`, so the *next* plain
  resume is in Plan again (it called `createPlanToolCall`). Every Agent turn would need
  `--mode plan` + prefix until the store is fixed. That's why rewriting the DB is the main fix.

## Code touch points

- `src/session/TabSession.ts` near `buildPrompt(...)` / `backend.run(...)`: call a new
  `cliChatStore.setMode(sessionId, 'default')` before the run when
  `run.mode === 'agent' && this.sessionMode && this.sessionMode !== 'agent'`, and on success set
  `this.sessionMode = 'agent'` so `buildPrompt` adds no prefix.
- `src/session/promptBuilder.ts`: keep `SWITCH_TO_AGENT_PREFIX` only for the fallback path.
- `src/backend/CliBackend.ts`: in the fallback path, pass `--mode plan` together with `--force`
  (today Agent mode passes only `--force`).
