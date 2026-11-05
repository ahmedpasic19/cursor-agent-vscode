# Next features plan (v0.10) — implemented in 0.10.0

Four features: image attachments, multi-root `@` mentions, Ctrl+I "Add to Cursor", MCP & plugins panel.
Decisions (2026-11-05): Q1 clickable CodeLens · Q2 left sidebar view · Q3 agent gets all folders via `--add-dir` · Q4 full manager with Add/Edit server form.

---

## 1. Images and screenshots

**Today:** the composer only takes text; chips are `selection | file | terminal | diagnostics`.
The CLI reads the prompt from stdin as plain text — there's no flag for passing an image.

**Approach**
- **Composer input:** paste (Ctrl+V from clipboard, e.g. Win+Shift+S screenshots), drag-and-drop image
  files, plus "Attach image…" in the `+` menu (opens a file picker). Accept png/jpg/jpeg/gif/webp, max ~10 MB each.
- **New chip kind** `image { id, path, name, mime, width?, height?, thumb }`: shows a thumbnail chip in the
  composer and in the sent user bubble. Click it to open a preview.
- **Storage:** the webview sends pasted bytes (base64) to the host, which writes
  `<storage>/attachments/<tabId>/<hash>.png`. Dropped or picked files keep their original path, so nothing is copied.
- **CLI delivery:** `serializeChips` emits `<image path="…" />`, and the prompt tells the agent to read the image
  with its Read tool. If the file is outside the workspace, add its folder with `--add-dir`.
  **Spike first:** check that the CLI's read tool really passes the pixels to the model and doesn't just
  report a binary file. Record a fixture `image-read.ndjson`. If it fails, fall back to a lower-quality
  stand-in and warn in the UI.
- **SDK delivery:** if `@cursor/sdk` `send()` accepts image content parts, send them natively; otherwise use
  the same path approach.
- History: image chips persist (path only). Clean up attachments when their chat is deleted or pruned.
- Tests: chip serialization, paste handler (harness), attachment cleanup.

## 2. `@` across all workspace folders

**Today:** `mention/search` indexes one root: the tab's `cwd` (the active editor's folder, else folder 0).
`mention/pick` joins the picked path to that same root. The CLI gets just `--workspace <cwd>`.

**Approach**
- `FileIndex.searchAll(roots, query)`: index each workspace folder separately (cached as now), merge,
  and score with one fuzzy pass. Candidates carry `root`.
- Multi-root display: show `folderName/rel/path`, with the folder name as a dim prefix. Single-root display stays as it is.
- `mention/pick` sends `{root, path}`, so the chip gets the right absolute path. File chips from another folder
  are serialized with an absolute path (or a path relative to the run's cwd).
- **CLI:** pass `--add-dir <folder>` for every other workspace folder (when the CLI supports it), so the agent
  can read and edit files in those folders too. The SDK gets the same through its options, if it supports that.
- Checkpoints stay cwd-only for now; warn if an Agent run edits files outside the cwd (**Q3 → all folders get --add-dir**).
- Tests: merge/score across roots, pick resolution, `buildArgs` with `--add-dir`.

## 3. Ctrl+I: "Add to Cursor"

**Today:** Ctrl+I focuses the chat, and Ctrl+L adds the selection (`addSelectionToChat` already exists, with merging of
overlapping selections).

**Approach**
- Rebind **Ctrl+I**: if the editor has a selection, add it as a chip and focus the composer; otherwise just focus the chat.
  Ctrl+L stays as an alias.
- **Inline affordance over the selection** (**Q1 → b, CodeLens**): a `CodeLens`-style hint is not anchored to a selection in VS Code,
  so the options are:
  a) a hint after the selection's first line, drawn with an editor decoration: `  Add to Cursor (Ctrl+I)`. It shows
     only while a selection exists and isn't clickable (VS Code decorations can't take clicks);
  b) a dynamic CodeLens above the selection's first line: `Add to Cursor (Ctrl+I)`. It's clickable but moves code
     down one line while you select;
  c) both, behind a setting `cursorAgent.selectionHint: "codelens" | "inline" | "off"`.
- Also: an "Add to Cursor" lightbulb Code Action (codeActions.ts already exists) and the context menu label renamed to match.

## 4. MCP & plugins panel

**CLI surface available:** `agent mcp list | list-tools <id> | enable <id> | disable <id> | login <id>`,
config in `.cursor/mcp.json` (project) and `~/.cursor/mcp.json` (global), and the flags `--approve-mcps` and `--plugin-dir`, plus
`agent plugin marketplace …`.

**Approach**
- A new **"MCP & Plugins"** view (**Q2 → left sidebar, under Sessions**) with these sections:
  - **MCP servers:** name, source (project/global), status from `mcp list` (ready / needs login / error / disabled),
    the tool count, and tools expandable via `list-tools`. Row actions: Enable, Disable, Log in, Show tools, Edit config (opens
    the right `mcp.json` at that server), Remove.
  - **Add server** form: name, type (stdio command+args+env / http url+headers), scope (project/global). Writes
    `mcp.json`, with secrets kept in env refs (**Q4 → full form**).
  - **Plugins:** local plugin dirs (`cursorAgent.pluginDirs` setting → `--plugin-dir`), and marketplace list/add if
    the `plugin marketplace` subcommands allow it.
  - Toggle `cursorAgent.approveMcps` → `--approve-mcps` (otherwise headless runs may quietly skip unapproved servers).
- Refresh when `mcp.json` changes (file watcher) and on demand. Parse `mcp list` text defensively (record fixtures).
- Show in the chat: MCP tool cards already exist (`uiKind: 'mcp'`); add the server name and a link to the panel.
- SDK backend: pass the same `mcp.json` servers through its options, if it supports that; otherwise mark the panel "CLI only".

---

## Order and size

1. Multi-root `@` (small, no unknowns)
2. Ctrl+I + selection hint (small)
3. Images (medium; starts with the CLI spike)
4. MCP & plugins panel (largest)

Each phase: typecheck, unit tests, harness check, a commit, and a version bump to 0.10.x.
