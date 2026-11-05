/**
 * "Add to Cursor (Ctrl+I)" CodeLens above the current editor selection. It appears once the
 * selection has been stable for a moment (so the code doesn't jump while you drag) and runs
 * cursorAgent.addSelectionToChat. Turned off by `cursorAgent.selectionCodeLens: false`.
 */
import * as vscode from 'vscode';

const SHOW_DELAY_MS = 250;

export class SelectionLens implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;
  /** Document + line the lens is shown on; undefined = no lens. */
  private shown: { uri: string; line: number } | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly subs: vscode.Disposable[];

  constructor(private readonly enabled: () => boolean, private readonly shortcut: string) {
    this.subs = [
      vscode.window.onDidChangeTextEditorSelection((e) => this.schedule(e.textEditor)),
      vscode.window.onDidChangeActiveTextEditor((e) => this.schedule(e)),
      this.changed,
    ];
  }

  private target(editor: vscode.TextEditor | undefined): { uri: string; line: number } | undefined {
    if (!editor || !this.enabled()) return undefined;
    const sel = editor.selections.find((s) => !s.isEmpty);
    if (!sel) return undefined;
    // Whitespace-only selections aren't worth a lens.
    if (!editor.document.getText(sel).trim()) return undefined;
    return { uri: editor.document.uri.toString(), line: sel.start.line };
  }

  private schedule(editor: vscode.TextEditor | undefined): void {
    if (this.timer) clearTimeout(this.timer);
    const next = this.target(editor);
    // Hide at once (no lingering lens while you start a new selection); show after a pause.
    if (!next) {
      if (this.shown) {
        this.shown = undefined;
        this.changed.fire();
      }
      return;
    }
    if (this.shown && this.shown.uri === next.uri && this.shown.line === next.line) return;
    this.timer = setTimeout(() => {
      this.shown = this.target(vscode.window.activeTextEditor);
      this.changed.fire();
    }, SHOW_DELAY_MS);
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const s = this.shown;
    if (!s || s.uri !== doc.uri.toString() || s.line >= doc.lineCount) return [];
    return [
      new vscode.CodeLens(new vscode.Range(s.line, 0, s.line, 0), {
        title: `$(sparkle) Add to Cursor (${this.shortcut})`,
        command: 'cursorAgent.addSelectionToChat',
        tooltip: 'Attach the selected lines to the Cursor chat as context',
      }),
    ];
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    for (const d of this.subs) d.dispose();
  }
}
