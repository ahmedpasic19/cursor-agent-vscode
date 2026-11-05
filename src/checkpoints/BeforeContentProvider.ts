import * as vscode from 'vscode';

/**
 * Serves in-memory "before" snapshots taken from edit tool events, so a tool card can open
 * a diff against the current file. Phase 4 adds checkpoint-backed diffs (DiffProvider).
 */
export class BeforeContentProvider implements vscode.TextDocumentContentProvider {
  static readonly scheme = 'cursor-agent-before';
  private readonly docs = new Map<string, string>();
  private seq = 0;

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.docs.get(uri.query) ?? '';
  }

  /** Stores content and returns a URI that keeps the file's name (so language detection works). */
  register(fsPath: string, content: string): vscode.Uri {
    const id = String(++this.seq);
    this.docs.set(id, content);
    // Keep memory bounded.
    if (this.docs.size > 50) this.docs.delete(this.docs.keys().next().value!);
    const name = fsPath.split(/[\\/]/).pop() ?? 'file';
    return vscode.Uri.from({ scheme: BeforeContentProvider.scheme, path: `/${name}`, query: id });
  }
}
