# Cursor Agent for VS Code — Implementation Plan

Working name: `cursor-agent-vscode`. This is a personal-use VS Code extension, installed from a `.vsix` file, that puts Cursor's agent inside VS Code with a UI comparable to the Claude Code extension. It also adds Cursor-style "Add to Chat" context.

Developer environment: Windows. The extension must work on Windows first. macOS and Linux should not be broken, but they are not tested.

---

## 1. Goals

1. Run Cursor's agent from a sidebar chat panel in VS Code, so the Cursor IDE never needs to be open.
2. Support multiple parallel chats in tabs. Each tab has its own session and its own agent process.
3. Let the user pick a mode per message:
   - **Agent** applies edits and runs commands automatically.
   - **Ask** is read-only.
   - **Plan** proposes a plan and makes no changes.
4. Add context the Cursor way with **Add to Chat**:
   - Editor selection chips
   - File and folder chips
   - Terminal output chips
   - Problems (diagnostics) chips
5. Make every Agent run reviewable and reversible:
   - A checkpoint is taken before each run.
   - The changed files are summarized after the run.
   - The user can open a per-file diff, revert a file, or revert everything.
6. Keep persistent history. Tabs, transcripts, and session IDs survive a VS Code restart.

Non-goals: publishing to the marketplace, cloud agents, team features, and reproducing Cursor's Tab autocomplete.

---

## 2. External facts this plan relies on (verify in Phase 0)

The plan is based on Cursor's public docs and community reports. **Do not trust these blindly.** Phase 0 exists to confirm each one against the CLI version that is actually installed.

### Cursor Agent CLI

The binary is `cursor-agent`. Newer installs may also provide `agent`.

**Headless invocation:** `cursor-agent -p --trust --output-format stream-json [--stream-partial-output] --workspace <path> [--model <id>] [--resume <session_id>]`. The prompt is passed on **stdin**.

- `-p` / `--print` is required. Without it, the CLI enters its TUI and hangs.
- `--trust` is required. Without it, the CLI prompts for workspace trust and hangs.

**Mode flags:**

- `--mode ask` makes the run read-only.
- `--mode plan` makes the run plan-only.
- Agent mode is the default mode, and needs `--force` (alias `--yolo`) to auto-approve tool and command execution.

**Session flags:**

- `--resume <id>` continues an existing session.
- `--continue` continues the most recent session.

**Worktree flag:** `-w <name>` runs the agent in a git worktree under `~/.cursor/worktrees/<repo>/<name>`. This is optional.

**`stream-json` output** is NDJSON, one event per line. The documented event types are:

- `{"type":"system","subtype":"init", "session_id", "model", "cwd", "apiKeySource", "permissionMode"}`
- `assistant` message events. With `--stream-partial-output`, small text deltas are emitted. The CLI also emits a buffered duplicate flush before tool calls; that flush carries `model_call_id` and must be skipped. **Phase 0:** it also emits a final duplicate at end of turn with no `timestamp_ms`, which must be skipped too.
- Thinking events (delta and completed).
- `{"type":"tool_call","subtype":"started"|"completed","call_id", "tool_call":{ "<kind>ToolCall": { "args": {...}, "result": {...} } }}`. Tool calls are separate top-level events, not inline content. The tool kind is the single key inside `tool_call`, such as `readToolCall`.
- `{"type":"result","subtype":"success", "is_error", "duration_ms", "result", "session_id"}` is the terminal event.

On failure, the process exits with a non-zero code, may end the stream without a `result` event, and writes the error to stderr.

**Known bug:** in headless mode, the process sometimes does not exit after the `result` event. The extension must treat `result` as the end of the turn and kill the process itself.

**Model selection:** pass `--model`, which accepts parameterized IDs such as `name[thinking=true,context=1m]`.

**Auth:** run `cursor-agent login` once. Check auth with something like `cursor-agent status`, and confirm the exact command with `--help`.

### Cursor TypeScript SDK (`@cursor/sdk`, public beta)

The SDK exposes the same agent runtime through a programmatic API: `Agent.create({ apiKey, model, local: { cwd } })`, then `agent.send()` returns a streamed run.

Constraints:

- It requires Node.js 22.13 or later.
- It ships native per-platform binaries.
- It authenticates with an API key and is billed by token usage.

**Decision:** use the **CLI as the primary backend**. It runs on the user's Cursor subscription login and needs no API key. Hide every backend behind an `AgentBackend` interface so an SDK backend can be added later (Phase 7, optional).

---

## 3. Architecture

```
┌──────────────────────────── VS Code ────────────────────────────┐
│                                                                  │
│  Editor / Terminal / Problems ──(Add to Chat commands)──┐        │
│                                                         ▼        │
│  ┌────────────── Extension Host (Node, TS) ─────────────────┐   │
│  │ ContextCollector   SessionManager ── TabSession[]         │   │
│  │                         │              ├─ AgentBackend     │   │
│  │ CheckpointService ◄─────┤              │   (CliBackend)    │   │
│  │ (shadow git)            │              ├─ EventParser      │   │
│  │ DiffProvider            │              └─ Transcript       │   │
│  │ HistoryStore ◄──────────┘                                  │   │
│  │ WebviewBridge (typed postMessage protocol)                 │   │
│  └──────────────────────────┬────────────────────────────────┘   │
│                             │                                    │
│  ┌──────── Sidebar WebviewView (React + Vite) ───────────────┐   │
│  │ TabBar │ MessageList │ ToolCards │ ChangesCard │ Composer │   │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
          │ spawn per run (stdin prompt, stdout NDJSON)
          ▼
     cursor-agent  (one child process per active tab run)
```

There are three key principles:

- The **extension host owns all state.** The webview is a pure view. It renders state snapshots and incremental events, and it sends user intents back.
- **One process per run, not per tab.** Each user message spawns `cursor-agent -p ... --resume <session_id>`, and the process exits or is killed at `result`. Continuity comes from `--resume`. This avoids long-lived processes and the TUI entirely.
- **Never guess the event schema.** Parse defensively. Unknown events are logged and rendered as a generic collapsed card, never dropped silently, and they never crash the parser.

---

## 4. Repository layout

```
cursor-agent-vscode/
├─ package.json                 # extension manifest (contributes: views, commands, keybindings, config)
├─ esbuild.mjs                  # bundles src/extension → dist/extension.js
├─ src/
│  ├─ extension.ts              # activate/deactivate, registration
│  ├─ backend/
│  │  ├─ AgentBackend.ts        # interface: run(opts) → AsyncIterable<AgentEvent>, cancel()
│  │  ├─ CliBackend.ts          # spawn, stdin, NDJSON line reader, kill-tree, timeouts
│  │  ├─ cliLocator.ts          # find cursor-agent (setting → PATH → known install dirs)
│  │  └─ cliCapabilities.ts     # parse `--help`, cache supported flags per CLI version
│  ├─ parser/
│  │  ├─ events.ts              # normalized AgentEvent union (our own types)
│  │  ├─ cursorStreamJson.ts    # raw Cursor NDJSON → AgentEvent; partial-output dedupe
│  │  └─ toolKinds.ts           # map readToolCall/editToolCall/shellToolCall/... → UI kinds
│  ├─ session/
│  │  ├─ SessionManager.ts      # tabs, concurrency limit, routing
│  │  ├─ TabSession.ts          # one tab: sessionId, mode, model, transcript, run state
│  │  └─ promptBuilder.ts       # chips + user text → final prompt string
│  ├─ context/
│  │  ├─ ContextCollector.ts    # selection, file, folder, terminal, problems → ContextChip
│  │  └─ commands.ts            # Add to Chat commands
│  ├─ checkpoints/
│  │  ├─ CheckpointService.ts   # shadow git repo per workspace
│  │  └─ DiffProvider.ts        # TextDocumentContentProvider for "cursor-checkpoint:" URIs
│  ├─ storage/HistoryStore.ts   # JSON files in globalStorageUri/<workspaceHash>/
│  ├─ webview/WebviewBridge.ts  # WebviewViewProvider + typed messaging + CSP
│  └─ shared/protocol.ts        # message types shared with webview (single source of truth)
├─ webview-ui/                  # React + Vite app, imports ../src/shared/protocol.ts
│  ├─ src/App.tsx
│  ├─ src/components/ (TabBar, MessageList, AssistantMessage, ThinkingBlock,
│  │                   ToolCard/*, ChangesCard, Composer, ContextChips,
│  │                   ModeSelect, ModelSelect, HistoryView, EmptyState, ErrorBanner)
│  └─ src/state/store.ts        # zustand store fed by host messages
├─ test/
│  ├─ fixtures/*.ndjson         # REAL recorded CLI output (Phase 0)
│  └─ *.test.ts                 # vitest
└─ docs/CLI_NOTES.md            # findings from Phase 0: real flags, real events, quirks
```

**Stack:**

- TypeScript in strict mode
- esbuild for the extension
- Vite, React 18, and zustand for the webview
- `markdown-it` with `shiki` for markdown and code highlighting, with themes matched to VS Code light and dark
- vitest for tests
- `@vscode/vsce` for packaging

---

## 5. Feature specifications

### 5.1 Sidebar and tabs

> **Superseded in v0.8 (Claude Code-style layout, see README):** the in-webview TabBar and HistoryView are gone. The chat shows one
> session in the secondary sidebar; the Session Manager in the activity-bar view lists, filters, groups and switches
> sessions. Parallel runs, queueing and the overlap warning below are unchanged ("tab" now means a loaded session).

- Contribute an activity-bar container with one `WebviewView`, "Cursor Agent". Use `retainContextWhenHidden: true` so streams are not lost when the panel is hidden.
- The TabBar sits at the top of the webview. It has:
  - **New tab (+)**, also available as the `cursorAgent.newChat` command.
  - **Close tab (×)**, which cancels the tab's running process.
  - **Rename** on double-click.
  - Tab titles that are auto-generated from the first user message (truncated to about 30 characters).
- Each tab shows a running indicator and an unread dot.
- Tabs run in parallel. A setting `cursorAgent.maxConcurrentRuns` (default 3) limits how many runs execute at once. Runs beyond the limit are queued, and their tab shows "Queued".
- **Same-file conflict warning:** if two Agent-mode runs in the same workspace overlap, show a non-blocking banner: "Another tab is also editing this workspace. Consider worktree mode." Optionally, a per-tab "Run in worktree" toggle uses `-w`, if Phase 0 confirms it works on Windows.

### 5.2 Modes (chosen per message)

| Mode | CLI flags | Behavior in UI |
|---|---|---|
| Agent | `--force` | Edits files and runs commands. A checkpoint is taken before the run. The Changes card is shown after. |
| Ask | `--mode ask` | Read-only. No checkpoint, no Changes card. |
| Plan | `--mode plan` | Renders the plan. Shows a **"Run this plan"** button that sends `Implement the plan above.` in Agent mode, resuming the same session. |

- The ModeSelect dropdown sits in the Composer. It remembers the last-used mode per tab. Setting: `cursorAgent.defaultMode`.
- `Shift+Tab` in the composer cycles modes, like Claude Code.
- Phase 0 must confirm that `--resume` works when the mode changes between turns. If it doesn't, Plan → Agent must start a new session and include the plan text in the prompt.
- **Phase 0 result:** the mode sticks to the session, and `--mode` only accepts `plan|ask`. Resuming a plan session in Agent mode works because the agent calls `switchModeToolCall`, which is auto-approved. "Run this plan" sends `Switch to agent mode and implement the plan above.` with `--force --resume <id>`. See `docs/CLI_NOTES.md` §7.

### 5.3 Composer

- A textarea that auto-grows. Enter sends; Shift+Enter inserts a newline. While a run is active, the send button becomes **Stop**, and `Esc` also stops.
- **`@` mentions:** a fuzzy file and folder picker built from `vscode.workspace.findFiles`, which respects `.gitignore` and `files.exclude`. Picking an item creates a chip.
- **`/` commands:** built-ins `/new`, `/clear` (starts a new session in the same tab), `/model`, `/mode`, `/history`, `/help`, plus **discovered skills** (`~/.cursor/skills/…/SKILL.md`, plugin skills, project `.cursor/skills`) and **custom commands** (`~/.cursor/commands/*.md`), listed and filterable in the same popup. Choosing a skill inserts `/name `; sending expands the prompt on the host so the transcript still shows what you typed.
- **Context chips** appear above the textarea (spec in 5.4). Each chip has an × to remove it. Chips are consumed on send. They are snapshotted into the user message so the transcript shows what was attached.
- **Model selector:** a list from `cursor-agent` model listing if Phase 0 finds such a command. Otherwise use the setting `cursorAgent.models` (string array) plus a free-text "custom" entry.

### 5.4 Add to Chat (the headline feature)

**Commands and default keybindings.** All keybindings are configurable.

| Command | Default key | When | Chip produced |
|---|---|---|---|
| `cursorAgent.addSelectionToChat` | `Ctrl+L` | `editorHasSelection` | Selection: `path:L10-24` plus a code snapshot |
| `cursorAgent.addFileToChat` | `Ctrl+Alt+L` | `editorTextFocus` | File: `path` |
| `cursorAgent.addFileToChat` (explorer) | context menu | explorer | File or folder |
| `cursorAgent.addTerminalSelectionToChat` | `Ctrl+L` | `terminalFocus` | Terminal: selected text (or last N lines) |
| `cursorAgent.addProblemsToChat` | context menu in the Problems view, plus a command | — | Diagnostics for the file or workspace |
| `cursorAgent.focusChat` | `Ctrl+I` | — | Focuses the composer |

**Behavior:**

- The command reveals the sidebar, adds the chip to the **active tab**, and focuses the composer. It **does not send** anything.
- Chips **stack**. The user can add five selections from three files before writing the message.
- An editor context-menu entry, "Add to Cursor Chat", and a CodeLens-style hover action above the selection are optional, in Phase 6.
- **Duplicate handling:** the same file and range is not added twice. Overlapping ranges in the same file are merged.
- **Selection chips snapshot the text** at the moment they are added. If the file changes before sending, the chip shows a small "changed" marker and sends the snapshot. The current file is still available to the agent through the path.
- **Phase 3 finding:** VS Code sends Ctrl+L in a focused terminal to the shell unless the command is listed in `terminal.integrated.commandsToSkipShell`. The first time Add Terminal to Chat is used (from the terminal context menu or the palette), the extension offers to add it there. That's a user setting, so it asks first.
- **Terminal selection:** use `Terminal.selection` if the installed VS Code API exposes it. Otherwise, run `workbench.action.terminal.copySelection`, read `vscode.env.clipboard`, and restore the previous clipboard content. If nothing is selected, fall back to the last 200 lines through shell integration's command output, when available.
- **Size limits:** each chip has a configurable maximum (default 2,000 lines). A chip over the limit is added as a path and line range only, with a warning.

**Prompt serialization** happens in `promptBuilder.ts`, and the prompt is sent via stdin:

```
<attached_context>
<selection path="src/booking/api.ts" lines="10-24" language="typescript">
...snapshot...
</selection>
<file path="src/booking/types.ts" />
<terminal_output>
...text...
</terminal_output>
<diagnostics path="src/app.tsx">
L12: error TS2339: Property 'x' does not exist on type 'Y'.
</diagnostics>
</attached_context>

<user_message>
...what the user typed...
</user_message>
```

All paths are workspace-relative and use forward slashes, including on Windows. File chips send paths only, and the agent reads the file itself. Selection chips send content, because the selected range is the point.

### 5.5 Message rendering

- **User message:** the typed text, plus read-only versions of the chips that were attached.
- **Assistant message:** streams markdown as it arrives. Code blocks get Copy, Insert at cursor, and Apply-to-file buttons. Apply-to-file is used when the block has a path hint and opens a diff preview first.
- **ThinkingBlock:** collapsed by default and shows a duration.
- **Tool cards** are built from `tool_call` started/completed pairs, matched by `call_id`. A card shows a spinner while running, a check or cross when done, and is collapsible.

| Kind | Header | Expanded |
|---|---|---|
| read | `Read path (Ln a–b)` | Clicking the header opens the file at that range |
| edit / write | `Edited path +x −y` | Inline mini-diff and an "Open diff" button |
| delete | `Deleted path` | Restore button (from checkpoint) |
| shell | `$ command` | Output (ANSI stripped), exit code |
| search / grep / glob / ls | `Searched "q" (n results)` | Result list, clickable |
| mcp / unknown | Tool name | Raw JSON, pretty-printed |

- Raw JSON is never shown by default except for unknown kinds.
- **Result footer** for each run: duration, model, and token usage if the event provides it.
- **Errors:** a non-zero exit or stderr output shows an ErrorBanner with the stderr tail and a Retry button. "Not logged in" errors show a "Run `cursor-agent login`" button, which opens a VS Code terminal with that command.

### 5.6 Checkpoints, Changes card, and revert

The **shadow git repository** follows the approach Cline uses for checkpoints. It works whether or not the workspace is a git repository, and it never touches the user's own `.git`.

- **Location:** `globalStorageUri/<workspaceHash>/shadow.git`
- **Commands:** `git --git-dir=<shadow> --work-tree=<workspaceRoot> ...`
- **Excludes:** honor the workspace `.gitignore`, and always exclude `node_modules`, `.git`, `dist`, `build`, and files larger than 5 MB. Excludes are configurable.
- **Requirement:** git must be on PATH. If it isn't, Agent mode shows a warning and runs without checkpoints.

**Before each Agent run:** `add -A` and `commit --allow-empty -m "pre:<tabId>:<runId>"`. Store the commit SHA on the run.

**After the run completes**, diff the working tree against the pre-run SHA to get the list of changed files and their +/- counts. This is authoritative, unlike the tool events, because it also catches files changed by shell commands.

**ChangesCard**, rendered after Agent runs:

- Lists the changed files with status (A/M/D) and +/- counts.
- Clicking a file opens `vscode.diff(cursor-checkpoint:<sha>/<path>, file:<path>)`. A TextDocumentContentProvider serves the old content with `git show <sha>:<path>`.
- Per-file buttons: **Revert file** and **Keep**.
- Card buttons: **Revert all** (with a confirmation dialog) and **Keep all**.

**Parallel-run caveat:** "Revert all" for one tab must only touch the files *that run* changed. Compute those files from its own pre/post diff, not by resetting the whole tree, because another tab's changes would also be reverted. Before restoring each file, check that it has no newer changes from another run. If it does, warn and ask.

**Restore checkpoint:** any earlier user message has "Restore code to before this message", which restores that run's changed files.

**Phase 4 notes (as built):**
- "Restore to before this message" restores every file changed by that message's run *and all later runs* in the tab, back to that run's pre-checkpoint. It asks first and lists files edited since.
- The shadow repo's `info/attributes` forces `-text` and unsets filters, and `core.autocrlf=false` is set on every call. Blobs are the exact file bytes, even if the user's repo has `autocrlf` or `eol` attributes.
- Hooks, GPG signing and inherited `GIT_*` environment variables are neutralized for shadow-git calls.
- Overlapping Agent runs (Phase 5): each run's pre/post diff also contains the other run's edits. Both runs get the conflict banner. Files that the *other* run's edit or delete tool calls touched (and this run's didn't) are flagged "other tab". Revert all and Restore skip them, and reverting one individually asks first. A file created by the other run's *shell command* isn't attributable from events, so it can still appear unflagged.

### 5.7 History and persistence

- **HistoryStore** saves one JSON file per chat under `globalStorageUri/<workspaceHash>/chats/<chatId>.json`. Each file holds:
  - Metadata: title, created and updated times, `sessionId`, mode, model
  - The normalized event transcript
  - Checkpoint SHAs
- **Writes** are debounced (about 500 ms) during streaming and flushed at `result`.
- **On startup,** the open tabs are restored. Runs that were active at shutdown are marked "Interrupted", with a Resume button that sends "continue" via `--resume`.
- **HistoryView** is a searchable list of past chats in this workspace. Opening one opens it in a tab and resumes its `sessionId` on the next message.
- **Retention setting:** `cursorAgent.historyLimit` (default 200 chats per workspace).

### 5.8 Settings (`contributes.configuration`)

| Setting | Default | Purpose |
|---|---|---|
| `cursorAgent.cliPath` | `""` | Path to the CLI. Empty means auto-detect. |
| `cursorAgent.defaultMode` | `"agent"` | Mode for new messages in a new tab |
| `cursorAgent.defaultModel` | `""` | Model for new tabs. Empty uses the CLI default. |
| `cursorAgent.models` | `[]` | Fallback model list for the selector |
| `cursorAgent.maxConcurrentRuns` | `3` | Parallel run limit |
| `cursorAgent.runTimeoutMinutes` | `30` | Hard kill timeout per run |
| `cursorAgent.postResultGraceMs` | `3000` | Wait after `result`, then kill the process (Phase 0: normal exit takes 0.9–1.6 s) |
| `cursorAgent.checkpoints.enabled` | `true` | Shadow-git checkpoints |
| `cursorAgent.checkpoints.exclude` | `[...]` | Extra exclude globs |
| `cursorAgent.context.maxChipLines` | `2000` | Size limit per chip |
| `cursorAgent.streamPartialOutput` | `true` | Use `--stream-partial-output` |
| `cursorAgent.extraArgs` | `[]` | Escape hatch for new CLI flags |

### 5.9 Status and auth

- On activation, locate the CLI and run its version and status commands.
- Possible states: **Ready**, **CLI not found** (show install instructions and a "Set path" button), and **Not logged in** (show a Login button).
- A status bar item shows "Cursor: ●" plus the number of running tabs. Clicking it focuses the chat.

---

## 6. CLI process handling (`CliBackend`)

**Spawning on Windows**

- Resolve the real executable. The npm or installer shim is often a `.cmd` or `.ps1` file.
- **Phase 0 finding:** the installer shim `cursor-agent.cmd` launches PowerShell, which runs `%LOCALAPPDATA%\cursor-agent\versions\<newest>\node.exe index.js`. Spawn that `node.exe` + `index.js` pair directly (see `docs/CLI_NOTES.md` §1).
- If only a `.cmd` is available, spawn with `shell: true` and quote the arguments carefully.
- Otherwise, spawn directly with `windowsHide: true`.
- Log the resolved path and the exact argument list to an OutputChannel, "Cursor Agent", for debugging.

**Prompt delivery**

- **Always pass the prompt on stdin**, never as an argument. The Windows `cmd` command line is limited to 8,191 characters, and quoting attached code safely is impractical.
- Write the prompt, then close stdin.
- Phase 0 must confirm that the CLI reads stdin when no prompt argument is given.

**Reading output**

- Use a line reader on stdout. Buffer partial lines, and split on `\n` with `\r` stripped.
- `JSON.parse` each line. If a line fails to parse, log it and continue.
- Keep stderr in a ring buffer of the last 200 lines, so errors can be shown.

**Ending the run**

- When the `result` event arrives, mark the run complete. Wait `postResultGraceMs`. If the process is still alive, kill the process tree. This works around the hang bug.
- If the process exits without a `result` event, treat the run as an error and show the stderr tail.

**Cancellation and timeout**

- Stop / Esc / tab close kill the process tree.
- On Windows, use `taskkill /pid <pid> /T /F`. Elsewhere, use `process.kill(-pid)` with `detached: true`.
- Mark the run "Stopped". The transcript is kept, and the next message resumes the session.
- The hard timeout is `runTimeoutMinutes`.

**Environment**

- Pass `process.env` unchanged. Do not set `CURSOR_API_KEY` unless the user configures it.
- Set `cwd` to the workspace root. In multi-root workspaces, each tab has its own root, chosen when the tab is created; the default is the root of the active editor's file.

**Capabilities**

- Run `--help` once per CLI version and cache the result.
- If a flag such as `--stream-partial-output`, `--mode`, or `-w` is not listed, disable the corresponding UI feature instead of failing.

---

## 7. Webview ↔ host protocol (`src/shared/protocol.ts`)

These are discriminated unions shared by both sides, and both sides validate them with `zod`.

**Host → Webview:**

- `state/full` (all tabs, active tab, settings, auth status)
- `tab/created`, `tab/updated`, `tab/closed`
- `run/started`, `run/event` (a normalized AgentEvent), `run/finished`, `run/error`
- `chips/updated`
- `changes/ready` (the changed-file list for a run)
- `history/list`

**Webview → Host:**

- `ready`
- `tab/new`, `tab/close`, `tab/rename`, `tab/activate`
- `message/send` (tabId, text, mode, model, chipIds)
- `run/stop`
- `chip/remove`, `mention/search` (returns file results), `mention/pick`
- `changes/openDiff`, `changes/revertFile`, `changes/revertAll`, `changes/keepAll`
- `checkpoint/restore`
- `plan/execute`
- `code/insert`, `code/apply`, `file/open`
- `history/open`, `history/delete`
- `auth/login`, `settings/open`

The webview must use a strict CSP with a nonce, `localResourceRoots` limited to `dist/webview`, and no remote resources.

---

## 8. UI design notes

- Use VS Code theme tokens only, such as `--vscode-sideBar-background`, `--vscode-input-background`, and `--vscode-textLink-foreground`, so the panel matches every theme, light or dark. No custom palette.
- Use `--vscode-font-family` for UI text and `--vscode-editor-font-family` for code.
- Keep the density close to Claude Code: compact tool cards, a single-line header per card, and details on expand.
- Motion only in response to user actions: expand and collapse, and a streaming caret. No entrance animations.
- Focus must be keyboard-reachable everywhere, with visible focus rings that use `--vscode-focusBorder`.
- Error and empty-state copy should say what to do, for example "No chats yet. Select code and press Ctrl+L, or type below."

---

## 9. Phases and acceptance criteria

Work through the phases in order. Do not start a phase until the previous phase's acceptance criteria pass. Commit at the end of each phase.

### Phase 0: CLI spike (no extension code yet)

- Write `scripts/record.ts`, which runs the CLI with given flags and a stdin prompt, and saves raw stdout and stderr to `test/fixtures/<name>.ndjson`.
- Record at least these cases:
  - Simple Ask question
  - Agent edit of one file
  - Agent run of a shell command
  - Plan mode
  - `--resume` follow-up
  - Mode switch on resume (plan → agent)
  - An error case (invalid model)
  - Partial output on and off
- Write `docs/CLI_NOTES.md` covering:
  - The exact binary path on this Windows machine
  - Real flags from `--help`
  - Every observed event and tool kind with an example
  - Whether stdin prompts work
  - Whether the hang bug reproduces
  - Whether mode switching on resume works
  - How to list models
  - How to check auth
- **Acceptance:** the fixtures exist, and the notes answer every "verify" item in sections 2 and 5.

### Phase 1: Skeleton and single-tab chat

- Scaffold the extension and the webview build, and register the sidebar view.
- Implement CliBackend, the parser (with tests against the fixtures), a basic TabSession, and streaming markdown rendering.
- **Acceptance:**
  - Asking a question streams an answer in the sidebar.
  - A follow-up message resumes the same session.
  - Stop kills the process within 1 second on Windows.
  - Parser tests pass on all fixtures.

### Phase 2: Tool cards, modes, and errors

- Implement all tool card kinds, the ModeSelect, and Plan's "Run this plan" button.
- Implement the ErrorBanner, the auth and CLI-not-found states, and the status bar item.
- **Acceptance:**
  - Each fixture renders correctly in a dev harness: a webview storybook page that replays the fixtures.
  - Unknown events render as raw cards.
  - The Plan → Agent flow works end to end.

### Phase 3: Add to Chat and the composer

- Implement all Add to Chat commands, keybindings, chips, `@` mentions, `/` commands, and promptBuilder.
- **Acceptance:**
  - Select code and press Ctrl+L; a chip appears and the composer is focused.
  - Three chips from two files plus a terminal chip are sent correctly. Verify by checking the prompt logged in the OutputChannel.
  - Duplicate and overlapping ranges merge.

### Phase 4: Checkpoints and the Changes card

- Implement CheckpointService, DiffProvider, the ChangesCard, revert, and restore-to-message.
- **Acceptance:**
  - After an Agent run that edits two files and runs a command creating a third file, the Changes card lists all three.
  - The diff opens.
  - Revert file and Revert all restore the exact original bytes, including CRLF line endings on Windows.
  - The user's own `.git` is untouched.

### Phase 5: Multiple tabs and history

- Implement the TabBar, parallel runs with the concurrency limit and queue, the conflict warning, HistoryStore, HistoryView, and restore after restart.
- **Acceptance:**
  - Two tabs stream at the same time without mixing events.
  - Restarting VS Code restores the tabs and transcripts.
  - Revert in tab A does not undo tab B's changes.

### Phase 6: Polish

- Add code block actions (copy, insert, apply), the explorer and Problems context menus, the optional worktree toggle, usage in the result footer, settings UI links, keyboard navigation, and empty states.
- **Acceptance:** this feels comparable to the Claude Code extension in daily use for a week.

### Phase 7 (optional): SDK backend

- Implement `SdkBackend` using `@cursor/sdk`, run in a separate Node child process. The extension host's Node version may not meet the SDK's Node 22.13+ requirement, and the native binaries are safer out-of-process.
- Add the setting `cursorAgent.backend: "cli" | "sdk"`. The SDK backend requires an API key stored in `SecretStorage`.
- **As built (see `docs/SDK_NOTES.md`):**
  - Pinned to @cursor/sdk 1.3.1, installed on demand with "Cursor Agent: Install SDK Backend" (npm into global storage). It isn't bundled because of its native binaries.
  - One worker process per run (`dist/sdk-worker.cjs`), started with `cursorAgent.sdk.nodePath` (Node 22.13+).
  - The SDK has no Ask mode, so Ask runs as Agent mode with an SDK-enforced read-only tool allowlist.
  - The local SDK requires a model; it falls back to `defaultModel`, then `auto`.
  - Worktrees aren't available with the SDK backend.

---

## 10. Testing

- **Unit tests (vitest):**
  - Parser against every fixture, using snapshot tests of the normalized events
  - promptBuilder
  - Chip merge logic
  - Diff stats
  - Process line reader with chunk splits in the middle of a line and of a multi-byte UTF-8 character
- **Integration tests (`@vscode/test-electron`):**
  - Add to Chat commands produce chips.
  - CheckpointService on a temporary workspace, including CRLF files and a non-git folder.
- **Fake CLI:** a `test/fake-cursor-agent.js` that replays a fixture with realistic delays and optionally hangs after `result`, so the extension can be tested without spending model usage. Point the `cursorAgent.cliPath` setting at it in tests.

---

## 11. Risks and mitigations

| Risk | Mitigation |
|---|---|
| CLI flags or event schema change between versions | Capabilities detection, a defensive parser, the raw-card fallback, the `extraArgs` escape hatch, and refreshed fixtures on update |
| Headless runs don't exit | Treat `result` as completion, then a grace period and a tree kill |
| No interactive approval in headless mode | Per-message modes, plus checkpoints with one-click revert |
| Parallel agents editing the same files | Conflict banner, per-run scoped revert, optional worktrees |
| Windows spawn and quoting issues | Prompt via stdin, resolved executable path, logged argv |
| Large workspaces make the shadow git slow | Excludes, a size cap, and an async snapshot with a 10 s timeout; if the timeout is hit, warn and run without a checkpoint |

---

## 12. Instructions for Claude Code

1. Start with **Phase 0** and do not write extension code before `docs/CLI_NOTES.md` exists. Ask me to run the recording script if it needs my logged-in CLI.
2. Wherever this plan and the real CLI behavior disagree, **the real behavior wins**. Update this plan and note the change in CLI_NOTES.md.
3. Keep `src/shared/protocol.ts` as the single source of truth for messages.
4. At the end of each phase, list what was done, show the acceptance checks and their results, and stop for my review.
5. Packaging: `npm run package` produces `cursor-agent-vscode-<version>.vsix`. Install it with `code --install-extension <file>`.
