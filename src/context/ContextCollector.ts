/**
 * Turns VS Code state (editor selections, files, terminals, diagnostics) into ContextChips.
 */
import * as vscode from 'vscode';
import type { ContextChip } from '../shared/protocol';
import { chipId } from './chips';

export interface CollectorWarning {
  warning?: string;
}

/**
 * Workspace-relative display path with forward slashes (absolute if outside the workspace).
 * With several folders open it starts with the folder name, so same-named files stay distinct.
 */
export function relPath(uri: vscode.Uri): string {
  const multi = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
  const rel = vscode.workspace.asRelativePath(uri, multi);
  return rel.replace(/\\/g, '/');
}

export function selectionChips(editor: vscode.TextEditor, maxLines: number): { chips: ContextChip[]; warning?: string } {
  const doc = editor.document;
  const chips: ContextChip[] = [];
  let warning: string | undefined;
  const sels = editor.selections.filter((s) => !s.isEmpty);
  for (const sel of sels) {
    const startLine = sel.start.line;
    // A selection ending at column 0 of the next line doesn't include that line.
    const endLine = sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line - 1 : sel.end.line;
    const count = endLine - startLine + 1;
    let text: string | undefined;
    if (count <= maxLines) {
      const range = new vscode.Range(startLine, 0, endLine, doc.lineAt(endLine).text.length);
      text = doc.getText(range).replace(/\r\n/g, '\n');
    } else {
      warning = `Selection has ${count} lines (limit ${maxLines}); attached as a path and line range only.`;
    }
    chips.push({
      id: chipId(),
      kind: 'selection',
      path: relPath(doc.uri),
      absPath: doc.uri.fsPath,
      startLine: startLine + 1,
      endLine: endLine + 1,
      language: doc.languageId,
      text,
    });
  }
  return { chips, warning };
}

export async function fileChip(uri: vscode.Uri): Promise<ContextChip | undefined> {
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    const isFolder = (stat.type & vscode.FileType.Directory) !== 0;
    return { id: chipId(), kind: 'file', path: relPath(uri), absPath: uri.fsPath, isFolder };
  } catch {
    return undefined;
  }
}

const SEVERITY = ['error', 'warning', 'info', 'hint'];

function formatDiagnostic(d: vscode.Diagnostic): string {
  const sev = SEVERITY[d.severity] ?? 'info';
  const code = typeof d.code === 'object' ? d.code.value : d.code;
  const src = d.source ? `${d.source}${code !== undefined ? String(code) : ''}` : code !== undefined ? String(code) : '';
  return `L${d.range.start.line + 1}: ${sev}${src ? ` ${src}` : ''}: ${d.message.replace(/\s*\n\s*/g, ' ')}`;
}

/**
 * Diagnostics for one file, or the whole workspace when `uri` is undefined.
 * Workspace mode includes errors and warnings only, capped to keep the prompt small.
 */
export function diagnosticsChip(uri: vscode.Uri | undefined, maxItems: number): ContextChip | undefined {
  const items: { path: string; line: string }[] = [];
  const entries: [vscode.Uri, readonly vscode.Diagnostic[]][] = uri
    ? [[uri, vscode.languages.getDiagnostics(uri)]]
    : vscode.languages.getDiagnostics();
  for (const [u, diags] of entries) {
    const sorted = [...diags]
      .filter((d) => uri || d.severity <= vscode.DiagnosticSeverity.Warning)
      .sort((a, b) => a.severity - b.severity || a.range.start.line - b.range.start.line);
    for (const d of sorted) {
      if (items.length >= maxItems) break;
      items.push({ path: relPath(u), line: formatDiagnostic(d) });
    }
  }
  if (!items.length) return undefined;
  return { id: chipId(), kind: 'diagnostics', path: uri ? relPath(uri) : undefined, items };
}

// ---------- terminal ----------

/**
 * Remembers the output of recent shell-integration commands per terminal, so "Add terminal to
 * chat" with nothing selected can attach the last output (PLAN.md §5.4).
 */
export class TerminalOutputTracker implements vscode.Disposable {
  private readonly last = new Map<vscode.Terminal, string>();
  private readonly subs: vscode.Disposable[] = [];

  constructor(private readonly maxLines = 200) {
    // Shell-integration APIs exist from VS Code 1.93; guard in case they are missing.
    const w = vscode.window as typeof vscode.window & {
      onDidStartTerminalShellExecution?: vscode.Event<vscode.TerminalShellExecutionStartEvent>;
    };
    if (w.onDidStartTerminalShellExecution) {
      this.subs.push(
        w.onDidStartTerminalShellExecution(async (e) => {
          let out = '';
          try {
            for await (const chunk of e.execution.read()) {
              out += chunk;
              if (out.length > 200_000) out = out.slice(-100_000);
            }
          } catch {
            return;
          }
          const cmd = e.execution.commandLine?.value;
          const text = cleanTerminalText(out, this.maxLines);
          this.last.set(e.terminal, cmd ? `$ ${cmd}\n${text}` : text);
        }),
      );
    }
    this.subs.push(vscode.window.onDidCloseTerminal((t) => this.last.delete(t)));
  }

  lastOutput(t: vscode.Terminal): string | undefined {
    return this.last.get(t);
  }

  dispose(): void {
    this.subs.forEach((s) => s.dispose());
  }
}

// eslint-disable-next-line no-control-regex
const ANSI = /[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))/g;

export function cleanTerminalText(s: string, maxLines: number): string {
  const lines = s
    .replace(ANSI, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '')
    .split('\n');
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
  return lines.slice(-maxLines).join('\n');
}

async function readViaClipboard(commands: string[]): Promise<string> {
  const previous = await vscode.env.clipboard.readText();
  const sentinel = `\u0000cursor-agent-${Date.now()}`;
  await vscode.env.clipboard.writeText(sentinel);
  try {
    for (const c of commands) await vscode.commands.executeCommand(c);
    const text = await vscode.env.clipboard.readText();
    return text === sentinel ? '' : text;
  } finally {
    await vscode.env.clipboard.writeText(previous);
  }
}

/**
 * Terminal chip: the selection if any, else the last command's output (shell integration),
 * else the last N lines of the buffer.
 */
export async function terminalChip(
  tracker: TerminalOutputTracker,
  maxLines: number,
): Promise<{ chip?: ContextChip; warning?: string }> {
  const term = vscode.window.activeTerminal;
  if (!term) return { warning: 'No active terminal.' };

  // 1. Selection: `Terminal.selection` where the API exposes it, else copy via the clipboard.
  let text = (term as vscode.Terminal & { selection?: string }).selection ?? '';
  if (!text) {
    text = await readViaClipboard(['workbench.action.terminal.copySelection']);
  }
  let source = 'selection';
  // 2. Last command output.
  if (!text.trim()) {
    text = tracker.lastOutput(term) ?? '';
    source = 'last command';
  }
  // 3. Whole buffer, last N lines.
  if (!text.trim()) {
    text = await readViaClipboard([
      'workbench.action.terminal.selectAll',
      'workbench.action.terminal.copySelection',
      'workbench.action.terminal.clearSelection',
    ]);
    source = 'buffer';
  }
  // A selection may be up to the chip limit; fallbacks attach the last 200 lines.
  const cleaned = cleanTerminalText(text, source === 'selection' ? maxLines : 200);
  if (!cleaned.trim()) return { warning: 'The terminal has no output to add.' };
  const lineCount = cleaned.split('\n').length;
  return {
    chip: { id: chipId(), kind: 'terminal', name: source === 'selection' ? term.name : `${term.name} (${source})`, text: cleaned, lineCount },
  };
}
