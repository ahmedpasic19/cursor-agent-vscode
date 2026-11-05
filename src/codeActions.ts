/**
 * Code block actions from the chat (PLAN.md §5.5): copy, insert at cursor, and apply to a file
 * after a diff preview. Edits go through WorkspaceEdit so they are undoable and keep the file's
 * line endings.
 */
import * as vscode from 'vscode';
import type { BeforeContentProvider } from './checkpoints/BeforeContentProvider';

export class CodeActions implements vscode.Disposable {
  /** The webview takes focus when a button is clicked, so remember the last real editor. */
  private lastEditor: vscode.TextEditor | undefined = vscode.window.activeTextEditor;
  private readonly sub = vscode.window.onDidChangeActiveTextEditor((e) => {
    if (e) this.lastEditor = e;
  });
  /** Replaceable in tests: answers the "Apply?" prompt. */
  confirmApply: (path: string) => Thenable<boolean> = async (path) =>
    (await vscode.window.showInformationMessage(`Apply the proposed code to ${path}?`, 'Apply', 'Discard')) === 'Apply';

  constructor(
    private readonly proposals: BeforeContentProvider,
    private readonly notice: (level: 'info' | 'warning' | 'error', text: string) => void,
  ) {}

  async copy(code: string): Promise<void> {
    await vscode.env.clipboard.writeText(code);
  }

  async insert(code: string): Promise<boolean> {
    const visible = vscode.window.visibleTextEditors;
    const editor = this.lastEditor && visible.includes(this.lastEditor) ? this.lastEditor : visible[0];
    if (!editor) {
      this.notice('warning', 'Open a file first — Insert puts the code at the cursor of the active editor.');
      return false;
    }
    const ok = await editor.edit((b) => {
      for (const sel of editor.selections) b.replace(sel, code);
    });
    if (ok) await vscode.window.showTextDocument(editor.document, editor.viewColumn);
    return ok;
  }

  /**
   * Shows the proposed content as a diff against the file (or an empty file if new), then asks.
   * Returns true if applied.
   */
  async apply(root: string | undefined, path: string, code: string): Promise<boolean> {
    const isAbs = /^([a-zA-Z]:[\\/]|\/)/.test(path);
    if (!isAbs && !root) {
      this.notice('error', 'Open a folder first — Apply needs a workspace to resolve the path.');
      return false;
    }
    const uri = isAbs ? vscode.Uri.file(path) : vscode.Uri.joinPath(vscode.Uri.file(root!), path);
    let exists = true;
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      exists = false;
    }
    const content = code.endsWith('\n') ? code : `${code}\n`;
    const name = uri.path.split('/').pop() ?? path;
    const proposed = this.proposals.register(uri.fsPath, content);
    const left = exists ? uri : this.proposals.register(uri.fsPath, '');
    await vscode.commands.executeCommand('vscode.diff', left, proposed, `${name} (current ↔ proposed)`, { preview: true });
    if (!(await this.confirmApply(path))) return false;

    const edit = new vscode.WorkspaceEdit();
    if (exists) {
      const doc = await vscode.workspace.openTextDocument(uri);
      edit.replace(uri, new vscode.Range(0, 0, doc.lineCount, 0), content);
    } else {
      edit.createFile(uri, { ignoreIfExists: true, contents: new TextEncoder().encode(content) });
    }
    const ok = await vscode.workspace.applyEdit(edit);
    if (ok && exists) await (await vscode.workspace.openTextDocument(uri)).save();
    if (ok) {
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      await vscode.window.showTextDocument(uri, { preview: true });
      this.notice('info', `Applied to ${path}. Use Undo in the editor to revert.`);
    }
    return ok;
  }

  dispose(): void {
    this.sub.dispose();
  }
}
