# Cursor Agent for VS Code

Runs Cursor's agent CLI from VS Code, laid out like Claude Code. MIT licensed — not on the
Marketplace, so clone it and build it. The landing page is in [site/](site/).

The layout:

- **Right (secondary sidebar):** the **Cursor** chat, one session at a time. It sits next to Claude Code as a tab.
  (VS Code < 1.106 has no secondary-sidebar contributions; there the chat is a second view in the left container.)
- **Left (activity bar "Cursor"):** **Account & Usage** (email, plan, backend, tokens used through this extension) and the
  **Session Manager** (new session, search, `Active · N` filter, groups with drag-and-drop, status + relative time).

- **Left, "MCP & Plugins":** MCP servers from `~/.cursor/mcp.json` and `<folder>/.cursor/mcp.json` with live status,
  tools, enable / disable / log in, and an Add/Edit form; plugin marketplaces, installed plugins, local plugin folders
  (`--plugin-dir`), and an *Auto-approve MCP servers* toggle (`--approve-mcps`).

Context:

- **Ctrl+I** (Cmd+I) with a selection adds it to the chat; with nothing selected it focuses the chat. An
  *Add to Cursor (Ctrl+I)* CodeLens shows above the selection (`cursorAgent.selectionCodeLens`). Ctrl+L in the editor is left to VS Code.
- **Looking at:** the composer's bottom bar shows the file you have open and, while you have something selected, how
  many lines — click either pill to attach it, exactly as Ctrl+I would. A pill that is already attached shows a ✓
  instead, and ✕ hides the pills until you move to something else.
- **Models:** the picker opens on a short list — Cursor's own models and a handful of the rest. *Show all models*, or
  just typing, searches the whole catalog.
- **Images and files:** paste a screenshot (Ctrl+V), hold Shift and drop files onto the panel, or *+ → Attach image*.
  Images are saved per chat and sent by path; other dropped files are attached as context chips.
- **Multi-root:** `@` searches every workspace folder; the other folders are passed to the agent with `--add-dir`.
  Checkpoints (Revert) cover only the folder the chat runs in.

Skills and custom slash prompts from `~/.cursor/skills`, `~/.cursor/commands`, plugins, and project `.cursor` / `.claude` folders appear in the composer **`/` menu** (filter as you type). Settings: `cursorAgent.skills.enabled`, `cursorAgent.skills.extraDirs`.

See PLAN.md, docs/CLI_NOTES.md and docs/NEXT_FEATURES_PLAN.md.

## Cursor CLI

The chat runs the [Cursor CLI](https://cursor.com/docs/cli/overview). Install it before you open the extension. `agent` must be on your PATH (`cursor-agent` is the same binary), then log in once with `agent login`.

**macOS** (install, then add `~/.local/bin` to PATH)

```bash
curl https://cursor.com/install -fsS | bash
```

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc
```

**Linux** (install, then add `~/.local/bin` to PATH)

```bash
curl https://cursor.com/install -fsS | bash
```

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc && source ~/.bashrc
```

**Windows (PowerShell)** (install, then add `%LOCALAPPDATA%\cursor-agent` to the user PATH)

```powershell
irm 'https://cursor.com/install?win32=true' | iex
```

```powershell
$p = [Environment]::GetEnvironmentVariable("Path", "User"); if ($p -notlike "*$env:LOCALAPPDATA\cursor-agent*") { [Environment]::SetEnvironmentVariable("Path", "$p;$env:LOCALAPPDATA\cursor-agent", "User") }
```

Open a new terminal after the PATH change. `agent --version` should print a version.

- Build: `npm run build`
- Test: `npm test` (real-CLI e2e: `CURSOR_E2E=1 npx vitest run test/e2e.real.test.ts`)
- Fixture harness: `npx vite --config webview-ui/vite.config.ts` then open `http://localhost:5173/harness.html` (lists every recorded + synthetic fixture, CLI states, Plan → Agent)
  and `http://localhost:5173/sessions-harness.html` (Session Manager rows in every status, groups, account states, budget bars)
- Package: `npm run package`, then `code --install-extension cursor-agent-vscode-<version>.vsix`

## Backends

- **CLI (default):** `cursor-agent` with your Cursor subscription login. Install commands are in [Cursor CLI](#cursor-cli) above.
- **SDK (optional):** set `cursorAgent.backend` to `sdk`, then run *Cursor Agent: Install SDK Backend* and
  *Cursor Agent: Set SDK API Key*. It's billed by usage and needs Node 22.13+. See `docs/SDK_NOTES.md`.
  Real-SDK e2e (opt-in): `CURSOR_SDK_E2E=1 CURSOR_API_KEY=… CURSOR_SDK_DIR=… npx vitest run test/e2e.sdk.real.test.ts`
