/**
 * Watches the active editor and its selection and reports them to the chat panel, so the
 * composer can show what you are looking at and let you attach it with one click.
 * Reporting only — attaching still goes through the Add-to-Chat commands.
 */
import * as vscode from 'vscode';
import type { ActiveEditorInfo } from '../shared/activeEditor';
import { relPath } from './ContextCollector';

/** Editors worth mirroring; diffs, output views and our own virtual documents are skipped. */
const SCHEMES = new Set(['file', 'untitled']);

const DEBOUNCE_MS = 120;

export class ActiveEditorWatcher implements vscode.Disposable {
  private readonly subs: vscode.Disposable[];
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Last payload sent, serialized — the webview is only told about real changes. */
  private sent: string | undefined;

  constructor(
    private readonly emit: (active: ActiveEditorInfo | undefined) => void,
    /** cursorAgent.showActiveEditor; off reports nothing, so the panel hides the pills. */
    private readonly enabled: () => boolean = () => true,
  ) {
    this.subs = [
      vscode.window.onDidChangeActiveTextEditor(() => this.schedule()),
      vscode.window.onDidChangeTextEditorSelection((e) => {
        if (e.textEditor === vscode.window.activeTextEditor) this.schedule();
      }),
    ];
  }

  /** The current state, computed fresh (used for the first push when the webview loads). */
  current(): ActiveEditorInfo | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !this.enabled() || !SCHEMES.has(editor.document.uri.scheme)) return undefined;
    const doc = editor.document;
    const info: ActiveEditorInfo = { path: relPath(doc.uri), absPath: doc.uri.fsPath, languageId: doc.languageId };
    const sels = editor.selections
      .filter((s) => !s.isEmpty && doc.getText(s).trim())
      .map((s) => {
        // A selection ending at column 0 of the next line doesn't include that line.
        const endLine = s.end.character === 0 && s.end.line > s.start.line ? s.end.line - 1 : s.end.line;
        return { startLine: s.start.line + 1, endLine: endLine + 1 };
      });
    if (sels.length) {
      info.startLine = sels[0]!.startLine;
      info.endLine = sels[0]!.endLine;
      info.selections = sels.length;
      info.selectedLines = sels.reduce((n, s) => n + s.endLine - s.startLine + 1, 0);
    }
    return info;
  }

  /** Send the current state now (skipped when it is the same as the last one sent). */
  push(force = false): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const info = this.current();
    const key = JSON.stringify(info ?? null);
    if (!force && key === this.sent) return;
    this.sent = key;
    this.emit(info);
  }

  /** Re-send on the next push even if nothing changed (the webview reloaded). */
  invalidate(): void {
    this.sent = undefined;
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.push(), DEBOUNCE_MS);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    for (const s of this.subs) s.dispose();
  }
}
