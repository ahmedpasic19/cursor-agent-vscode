# Cursor Agent for VS Code

Personal-use extension that runs Cursor's agent CLI from a VS Code sidebar. See PLAN.md and docs/CLI_NOTES.md.

- Build: `npm run build`
- Test: `npm test` (real-CLI e2e: `CURSOR_E2E=1 npx vitest run test/e2e.real.test.ts`)
- Fixture harness: `npx vite --config webview-ui/vite.config.ts` then open `http://localhost:5173/harness.html` (lists every recorded + synthetic fixture, CLI states, Plan → Agent)
- Package: `npm run package`, then `code --install-extension cursor-agent-vscode-<version>.vsix`

## Backends

- **CLI (default):** `cursor-agent` with your Cursor subscription login.
- **SDK (optional):** set `cursorAgent.backend` to `sdk`, then run *Cursor Agent: Install SDK Backend* and
  *Cursor Agent: Set SDK API Key*. It's billed by usage and needs Node 22.13+. See `docs/SDK_NOTES.md`.
  Real-SDK e2e (opt-in): `CURSOR_SDK_E2E=1 CURSOR_API_KEY=… CURSOR_SDK_DIR=… npx vitest run test/e2e.sdk.real.test.ts`
