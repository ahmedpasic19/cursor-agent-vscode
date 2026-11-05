# Cursor Agent for VS Code

Personal-use extension that runs Cursor's agent CLI from a VS Code sidebar. See PLAN.md and docs/CLI_NOTES.md.

- Build: `npm run build`
- Test: `npm test` (real-CLI e2e: `CURSOR_E2E=1 npx vitest run test/e2e.real.test.ts`)
- Webview harness: `npx vite --config webview-ui/vite.config.ts` then open `/harness.html?fixture=plan-mode`
- Package: `npm run package`, then `code --install-extension cursor-agent-vscode-<version>.vsix`
