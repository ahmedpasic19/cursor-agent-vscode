# Cursor Agent CLI — Phase 0 findings

CLI version: **2026.11.05-86047df** on Windows 11 x64, recorded 2026-11-05.
Fixtures: `test/fixtures/<name>.ndjson` (stdout), `.stderr.txt`, `.meta.json` (argv, exit code, timings).

Status legend: ✅ verified on this machine · ⏳ pending (needs `npm run record:agent`, see bottom) · ❌ differs from PLAN.md

---

## 1. Binary location and spawning ✅ (differs from plan)

- Shims on PATH: `%LOCALAPPDATA%\cursor-agent\cursor-agent.cmd` and `agent.cmd` (plus `.ps1`).
- The `.cmd` shim launches **PowerShell**, which then runs the newest version directory:
  `%LOCALAPPDATA%\cursor-agent\versions\<YYYY.MM.DD-commit>\node.exe  ...\index.js  <args>`
- Version dir names match `^\d{4}\.\d{1,2}\.\d{1,2}(-\d{2}-\d{2}-\d{2})?-[a-f0-9]+$`. Pick the newest by date.
  The shim also runs `versions\promote-staged.cmd` first (applies staged auto-updates).
- **Decision (changes plan §6):** `cliLocator` resolves the real `node.exe` + `index.js` pair and spawns it
  directly (`shell: false`, `windowsHide: true`). This avoids cmd quoting, PowerShell startup cost, and makes
  `taskkill /T` reliable. Fallback order: `cursorAgent.cliPath` setting → versions dir → `cursor-agent.cmd`
  on PATH (spawned with `shell: true`). Because we bypass the shim, we skip `promote-staged`; that's fine,
  the next manual `cursor-agent` run promotes updates. Set `CURSOR_INVOKED_AS=cursor-agent` like the shim does.
- On macOS/Linux use `cursor-agent` from PATH (untested).

## 2. Flags (from `--help`) ✅

Confirmed exist: `-p/--print`, `--output-format text|json|stream-json`, `--stream-partial-output`,
`--mode plan|ask`, `--plan`, `--resume [chatId]`, `--continue`, `--model`, `--list-models`, `-f/--force`,
`--yolo`, `--trust`, `--workspace`, `--add-dir`, `-w/--worktree [name]`, `--worktree-base`,
`--sandbox enabled|disabled`, `--approve-mcps`, `--auto-review`, `--api-key`, `-H/--header`, `-e/--endpoint`.

New since the plan was written (possibly useful later): `--auto-review` (server classifier approves safe
calls), `--sandbox`, `--add-dir`, `create-chat` subcommand (returns a new chat ID), `about`, `models`.

## 3. Prompt on stdin ✅

With `-p` and no positional prompt, the CLI reads the whole of stdin as the prompt. All fixtures were
recorded this way (prompt written, stdin closed). Non-ASCII in the prompt was not tested yet; write UTF-8.

## 4. Auth and models ✅

- `cursor-agent status --format json` → `{"status":"authenticated","isAuthenticated":true,"userInfo":{...}}`
  (exit 0). Use this, not text parsing. Alias: `whoami`. Not-logged-in shape not yet observed — treat
  `isAuthenticated !== true` or non-zero exit as "Not logged in".
- `cursor-agent models` (or `--list-models`) prints text: header `Available models`, blank line, then
  `<id> - <label>` lines; the current default is suffixed ` (current, default)`. ~270 models.
  Parse with `/^(\S+) - (.+?)( \(current(, default)?\))?$/`. Some labels contain zero-width chars — trim them.
- `cursor-agent --version` → `2026.11.05-86047df`. Use it as the capabilities cache key.
- `about` shows tier, default model, shell.

## 5. Event stream (`stream-json`) ✅

All events carry `session_id`. Most carry `timestamp_ms`. Observed types:

| type / subtype | Notes |
|---|---|
| `system` / `init` | `apiKeySource:"login"`, `cwd`, `session_id`, `model` (display name, e.g. `"Composer 2.5 Fast"`), `permissionMode:"default"` |
| `user` | Echo of the prompt: `message.content[{type:"text",text}]` |
| `thinking` / `delta` | `text` chunk |
| `thinking` / `completed` | No text. One thinking block per model step; several per run. |
| `assistant` | `message.content[{type:"text",text}]`. See dedupe rules below. |
| `tool_call` / `started` | `call_id`, `tool_call: { <kind>ToolCall: { args } , toolCallId, startedAtMs }`, `model_call_id` |
| `tool_call` / `completed` | Same plus `args.result: { success: {...} }` (or presumably `error`), `completedAtMs` |
| `interaction_query` / `request` + `response` | Plan mode: `query_type:"createPlanRequestQuery"`; auto-answered in headless mode. Informational — render nothing. |
| `result` / `success` | `duration_ms`, `duration_api_ms`, `is_error`, `result` (final text), `session_id`, `request_id`, **`usage {inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}`** |

Tool calls can **interleave** (two `started` before either `completed`, see `plan-mode`), so always match by `call_id`.

### Tool kinds seen so far

| Key | args | result.success |
|---|---|---|
| `readToolCall` | `path` (absolute, Windows backslashes) | `content`, `totalLines`, `fileSize`, `readRange{startLine,endLine}` |
| `globToolCall` | `globPattern`, `targetDirectory?` | `files[]` (relative, may be `".\\math.ts"` or `"../.\\math.ts"` — normalize), `totalFiles` |
| `grepToolCall` | `pattern`, `path`, `outputMode`, `caseInsensitive` | `workspaceResults{<root>:{content:{matches[],totalMatchedLines}}}` |
| `createPlanToolCall` | `plan` (markdown), `overview`, `name`, `todos[]` | `{}` |
| `editToolCall` | `path`, `streamContent` (new text / snippet) | `path`, `linesAdded`, `linesRemoved`, `diffString` (unified diff, absolute paths, `--- /dev/null` for new files), `beforeFullFileContent?` (absent for new files), `afterFullFileContent`, `message` |
| `shellToolCall` | `command`, `workingDirectory`, `timeout`, `description`, `isBackground`, parsed command info | `command`, `exitCode`, `signal`, `stdout`, `stderr`, `interleavedOutput`, `executionTime` |
| `switchModeToolCall` | `targetModeId` (`"agent"`), `explanation` | `{fromModeId, toModeId}` |
| delete / ls / mcp | not seen yet; fall back to the generic card |

Errors use `result.error: { error, modelVisibleError, path }` instead of `result.success`
(seen: `"Cannot edit non markdown files in plan mode"`). New files are written with `editToolCall` (there's no separate write kind).
`before/afterFullFileContent` are LF-normalized, but **the file on disk kept its CRLF endings** (`agent-edit`), so the inline mini-diff can use `diffString` while checkpoints stay byte-exact.

Read `content` has **CRLF converted to LF** — don't use it for byte-exact work (checkpoints do that).

### Assistant text dedupe ✅ (refines plan §2)

With `--stream-partial-output`:
1. Deltas have `timestamp_ms` and **no** `model_call_id` → append.
2. Before a tool call, the CLI re-emits the buffered segment **with `model_call_id`** → skip.
3. At end of turn, the CLI re-emits the final segment **with neither `timestamp_ms` nor `model_call_id`** → skip.

Rule implemented in the parser: in partial mode, an `assistant` event is a duplicate if it has `model_call_id`
**or** lacks `timestamp_ms`. Safety net: also skip if its text equals the text accumulated for the current segment.

Without `--stream-partial-output` (`ask-no-partial`): one `assistant` event per segment, no `timestamp_ms`,
no `model_call_id` → append as a whole. So the "lacks timestamp" rule only applies in partial mode.

## 6. Exit and the hang bug

- All 10 successful runs (Ask, Plan, and Agent with `--force`) exited by themselves **0.75–2.0 s after `result`**
  (`exitedAfterResultMs`; slowest was `switch-agent` at 2033 ms). **The hang bug did not reproduce** in this version.
  We keep the kill-after-grace safety net anyway. Default `postResultGraceMs = 1500` would have killed `switch-agent`
  early, so the **default is 3000**.
- Error case (`invalid-model`): exit code **1**, **empty stdout** (not even `system:init`), message on stderr:
  `Cannot use this model: no-such-model-xyz. Available models: ...`. ErrorBanner should show the first line
  of stderr, truncated.

## 7. Resume ✅

`--resume <session_id>` continues the conversation (model recalled the previous question; `ask-resume`).
The resumed run's `system:init` and `result` report the **same `session_id`**. Prompt caching kicks in
(`cacheReadTokens` high).

### Mode switch on resume ✅ (differs from plan)

**The mode sticks to the session.** `switch-agent` resumed a plan session with `--force` and no `--mode`. The
first edit failed with `Cannot edit non markdown files in plan mode`. Then the agent called `switchModeToolCall`
(`plan → agent`); in headless mode, an `interaction_query` `switchModeRequestQuery` was auto-approved, and the edit then succeeded.
`--mode` only accepts `plan|ask`, so there's no `--mode agent` to force it back.

Implementation consequence:
- **Plan → Agent ("Run this plan")**: resume the same session with `--force` and send
  `Switch to agent mode and implement the plan above.` (the explicit "switch" avoids the wasted failed edit).
  This works end to end. A fallback is a new session with the plan text in the prompt, if the switch ever fails.
- **Agent/Ask → Plan/Ask**: pass `--mode` on resume (the flag applies at start).
- **Ask → Agent**: same as Plan → Agent: prefix the prompt with the switch instruction.
- TabSession tracks the session's *current* mode (it updates on `switchModeToolCall` results) so it knows when a prefix is needed.

## 8. Plan mode ✅

The plan arrives as a `createPlanToolCall` (`args.plan` markdown, `todos[]`), plus short assistant text.
**UI: render a dedicated Plan card from `createPlanToolCall.args.plan`** and attach "Run this plan" to it,
instead of relying on assistant text.

## 9. Worktrees ⏳

`-w [name]` and `--worktree-base` exist. Not exercised (needs a git repo and creates dirs under
`~/.cursor/worktrees`). Keep the per-tab worktree toggle behind a "verified" flag until tested in Phase 6.

## 10. Plan changes made because of these findings

- §6: spawn `node.exe index.js` directly instead of `.cmd` with `shell: true`.
- §5.8: `postResultGraceMs` default 1500 → 3000.
- §5.3: model list comes from `cursor-agent models`; `cursorAgent.models` is only a fallback.
- §5.5: result footer can show token usage (it's in `result.usage`). Plan card from `createPlanToolCall`.
- §5.9: auth check is `status --format json`.

- §5.2: Plan → Agent resumes the same session with a "switch to agent mode" prompt prefix (mode is sticky per session).
- §11: the hang bug did not reproduce in 2026.11.05, but the safety net stays.

---

## Re-recording

`npm run record:agent` re-records the Agent-mode fixtures (`agent-edit`, `agent-shell`, `agent-no-partial`,
`switch-plan`, `switch-agent`, `hang-probe`) in a throwaway temp workspace. The read-only fixtures
(`ask-simple`, `ask-no-partial`, `ask-resume`, `plan-mode`, `invalid-model`) are recorded with
`npm run record -- <name> --cwd <dir> --prompt "..." -- <flags>`. Re-record after CLI updates.
