import * as vscode from 'vscode';
import type { CheckpointService } from './CheckpointService';

/**
 * Serves file contents from checkpoint commits for diff views (PLAN.md §5.6).
 * URI: cursor-checkpoint:/<relative path>?<sha>|<encoded root>
 */
export class DiffProvider implements vscode.TextDocumentContentProvider {
  static readonly scheme = 'cursor-checkpoint';

  constructor(private readonly getService: (root: string) => CheckpointService | undefined) {}

  static uri(root: string, sha: string, relPath: string): vscode.Uri {
    return vscode.Uri.from({ scheme: DiffProvider.scheme, path: `/${relPath}`, query: `${sha}|${encodeURIComponent(root)}` });
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const [sha, encRoot] = uri.query.split('|');
    if (!sha || !encRoot || sha === 'empty') return '';
    const svc = this.getService(decodeURIComponent(encRoot));
    if (!svc) return '';
    const buf = await svc.readBlob(sha, uri.path.replace(/^\//, ''));
    if (!buf) return '';
    if (buf.subarray(0, 8000).includes(0)) return '(binary file — no text diff)';
    return buf.toString('utf8');
  }
}
