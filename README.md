# Cursor Agent for VS Code

Personal-use extension that runs Cursor's agent CLI from VS Code, laid out like Claude Code:

- **Right (secondary sidebar):** the **Cursor** chat, one session at a time. It sits next to Claude Code as a tab.
  (VS Code < 1.106 has no secondary-sidebar contributions; there the chat is a second view in the left container.)
- **Left (activity bar "Cursor"):** **Account & Usage** (email, plan, backend, tokens used through this extension) and the
  **Session Manager** (new session, search, `Active · N` filter, groups with drag-and-drop, status + relative time).

See PLAN.md and docs/CLI_NOTES.md.

- Build: `npm run build`
- Test: `npm test` (real-CLI e2e: `CURSOR_E2E=1 npx vitest run test/e2e.real.test.ts`)
- Fixture harness: `npx vite --config webview-ui/vite.config.ts` then open `http://localhost:5173/harness.html` (lists every recorded + synthetic fixture, CLI states, Plan → Agent)
  and `http://localhost:5173/sessions-harness.html` (Session Manager rows in every status, groups, account states, budget bars)
- Package: `npm run package`, then `code --install-extension cursor-agent-vscode-<version>.vsix`

## Backends

- **CLI (default):** `cursor-agent` with your Cursor subscription login.
- **SDK (optional):** set `cursorAgent.backend` to `sdk`, then run *Cursor Agent: Install SDK Backend* and
  *Cursor Agent: Set SDK API Key*. It's billed by usage and needs Node 22.13+. See `docs/SDK_NOTES.md`.
  Real-SDK e2e (opt-in): `CURSOR_SDK_E2E=1 CURSOR_API_KEY=… CURSOR_SDK_DIR=… npx vitest run test/e2e.sdk.real.test.ts`
