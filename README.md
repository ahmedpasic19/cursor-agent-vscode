# Cursor Agent for VS Code

Personal-use extension that runs Cursor's agent CLI from a VS Code sidebar. See PLAN.md and docs/CLI_NOTES.md.

- Build: `npm run build`
- Test: `npm test` (real-CLI e2e: `CURSOR_E2E=1 npx vitest run test/e2e.real.test.ts`)
- Fixture harness: `npx vite --config webview-ui/vite.config.ts` then open `http://localhost:5173/harness.html` (lists every recorded + synthetic fixture, CLI states, Plan → Agent)
- Package: `npm run package`, then `code --install-extension cursor-agent-vscode-<version>.vsix`
