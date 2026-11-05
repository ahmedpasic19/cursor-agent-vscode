/**
 * Add to Chat commands (PLAN.md §5.4). Each one reveals the sidebar, adds chips to the
 * active tab, and focuses the composer. Nothing is sent.
 */
import * as vscode from 'vscode';
import type { ContextChip } from '../shared/protocol';
import type { SessionManager } from '../session/SessionManager';
import { diagnosticsChip, fileChip, selectionChips, TerminalOutputTracker, terminalChip } from './ContextCollector';

export interface AddToChatDeps {
  manager: SessionManager;
  reveal(): Promise<void>;
  focusComposer(): void;
  notice(level: 'info' | 'warning' | 'error', text: string): void;
  maxChipLines(): number;
  log(line: string): void;
}

export function registerAddToChat(context: vscode.ExtensionContext, deps: AddToChatDeps): void {
  const tracker = new TerminalOutputTracker();

  const add = async (chips: ContextChip[], warning?: string) => {
    await deps.reveal();
    const tab = deps.manager.ensureTab();
    for (const c of chips) {
      const action = tab.addChip(c, deps.maxChipLines());
      deps.log(`[chips] ${action} ${c.kind}${'path' in c && c.path ? ` ${c.path}` : ''}`);
    }
    if (warning) deps.notice('warning', warning);
    deps.focusComposer();
  };

  context.subscriptions.push(
    tracker,

    vscode.commands.registerCommand('cursorAgent.addSelectionToChat', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const { chips, warning } = selectionChips(editor, deps.maxChipLines());
      if (!chips.length) {
        // No selection: add the file instead.
        const c = await fileChip(editor.document.uri);
        return add(c ? [c] : []);
      }
      await add(chips, warning);
    }),

    // Editor (no args), explorer / editor tab context menus (uri, selected uris).
    vscode.commands.registerCommand('cursorAgent.addFileToChat', async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
      const targets = uris?.length ? uris : uri instanceof vscode.Uri ? [uri] : [];
      if (!targets.length && vscode.window.activeTextEditor) targets.push(vscode.window.activeTextEditor.document.uri);
      const chips = (await Promise.all(targets.map(fileChip))).filter((c): c is ContextChip => !!c);
      await add(chips);
    }),

    vscode.commands.registerCommand('cursorAgent.addTerminalSelectionToChat', async () => {
      const { chip, warning } = await terminalChip(tracker, deps.maxChipLines());
      await add(chip ? [chip] : [], warning);
      void offerTerminalKeybinding(context);
    }),

    // Problems: active file (or a marker's resource from the Problems view), else workspace.
    vscode.commands.registerCommand('cursorAgent.addProblemsToChat', async (arg?: unknown) => {
      const resource =
        arg instanceof vscode.Uri
          ? arg
          : (arg as { resource?: vscode.Uri; uri?: vscode.Uri } | undefined)?.resource ??
            (arg as { uri?: vscode.Uri } | undefined)?.uri ??
            vscode.window.activeTextEditor?.document.uri;
      let chip = resource ? diagnosticsChip(resource, 200) : undefined;
      if (!chip) chip = diagnosticsChip(undefined, 200);
      if (!chip) return add([], 'No problems to add.');
      await add([chip]);
    }),

    vscode.commands.registerCommand('cursorAgent.addWorkspaceProblemsToChat', async () => {
      const chip = diagnosticsChip(undefined, 200);
      await add(chip ? [chip] : [], chip ? undefined : 'No errors or warnings in the workspace.');
    }),

    // "changed" marker for selection snapshots.
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (!e.contentChanges.length) return;
      const fsPath = e.document.uri.fsPath.toLowerCase();
      for (const tab of deps.manager.tabs) {
        tab.updateChips((c) => {
          if (c.kind !== 'selection' || c.changed || c.text === undefined || c.absPath.toLowerCase() !== fsPath) return c;
          const doc = e.document;
          if (c.endLine > doc.lineCount) return { ...c, changed: true };
          const now = doc
            .getText(new vscode.Range(c.startLine - 1, 0, c.endLine - 1, doc.lineAt(c.endLine - 1).text.length))
            .replace(/\r\n/g, '\n');
          return now === c.text ? c : { ...c, changed: true };
        });
      }
    }),
  );
}

/**
 * Ctrl+L in a focused terminal only reaches our command if it is listed in
 * terminal.integrated.commandsToSkipShell. Offer (once) to add it — it's a user setting.
 */
export async function offerTerminalKeybinding(context: vscode.ExtensionContext): Promise<void> {
  const key = 'offeredTerminalSkipShell';
  if (context.globalState.get(key)) return;
  const cfg = vscode.workspace.getConfiguration('terminal.integrated');
  const list = cfg.get<string[]>('commandsToSkipShell', []);
  if (list.includes('cursorAgent.addTerminalSelectionToChat')) return;
  await context.globalState.update(key, true);
  const choice = await vscode.window.showInformationMessage(
    'Cursor Agent: let Ctrl+L in the terminal add the selection to chat? (Adds the command to terminal.integrated.commandsToSkipShell; the shell will no longer receive Ctrl+L.)',
    'Enable',
    'Not now',
  );
  if (choice === 'Enable') {
    await cfg.update('commandsToSkipShell', [...list, 'cursorAgent.addTerminalSelectionToChat'], vscode.ConfigurationTarget.Global);
  }
}
