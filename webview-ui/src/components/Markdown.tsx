import MarkdownIt from 'markdown-it';
import { memo, useEffect, useMemo, useState, type MouseEvent } from 'react';
import { parseFenceInfo, stripPathComment } from '../codeBlocks';
import { highlight, isHighlighterReady, onHighlighterReady } from '../highlight';
import { send } from '../vscode';
import { useTab } from './tools/util';

const md = new MarkdownIt({ html: false, linkify: true, breaks: false });

// Open links outside the webview; file links open in the editor.
const defaultLink = md.renderer.rules.link_open ?? ((t, i, o, _e, s) => s.renderToken(t, i, o));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx]!.attrSet('data-href', tokens[idx]!.attrGet('href') ?? '');
  return defaultLink(tokens, idx, options, env, self);
};

const esc = (s: string) => md.utils.escapeHtml(s);

// Code blocks: toolbar with Copy / Insert / Apply (or Open for citations), Shiki highlighting.
md.renderer.rules.fence = (tokens, idx) => {
  const token = tokens[idx]!;
  const code = token.content.replace(/\n$/, '');
  const info = parseFenceInfo(token.info, code);
  const highlighted = highlight(code, info.lang);
  const pre = highlighted ?? `<pre><code>${esc(code)}</code></pre>`;
  const label = info.citation
    ? `${info.citation.path}:${info.citation.startLine}-${info.citation.endLine}`
    : [info.lang, info.path].filter(Boolean).join(' · ');
  const attrs = [
    info.path ? `data-path="${esc(info.path)}"` : '',
    info.lang ? `data-lang="${esc(info.lang)}"` : '',
    info.citation ? `data-cite="${esc(`${info.citation.startLine}:${info.citation.endLine}:${info.citation.path}`)}"` : '',
  ].join(' ');
  const buttons = [
    info.citation ? `<button class="code-btn" data-action="open" title="Open ${esc(info.citation.path)}">Open</button>` : '',
    `<button class="code-btn" data-action="copy" title="Copy to clipboard">Copy</button>`,
    `<button class="code-btn" data-action="insert" title="Insert at the cursor in the active editor">Insert</button>`,
    info.path && !info.citation
      ? `<button class="code-btn" data-action="apply" title="Preview a diff, then apply to ${esc(info.path)}">Apply</button>`
      : '',
  ].join('');
  return `<div class="code-block" ${attrs}><div class="code-toolbar"><span class="code-label">${esc(label)}</span><span class="code-actions">${buttons}</span></div>${pre}</div>`;
};

export const Markdown = memo(function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
  const { tabId } = useTab();
  const [hlReady, setHlReady] = useState(isHighlighterReady());
  useEffect(() => onHighlighterReady(() => setHlReady(true)), []);
  const html = useMemo(() => md.render(text), [text, hlReady]);

  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const btn = target.closest('button[data-action]') as HTMLButtonElement | null;
    if (btn) {
      e.preventDefault();
      const block = btn.closest('.code-block') as HTMLElement | null;
      const code = block?.querySelector('pre code, pre')?.textContent ?? '';
      const action = btn.dataset.action;
      if (action === 'copy') {
        send({ type: 'code/copy', code });
        btn.textContent = 'Copied';
        setTimeout(() => (btn.textContent = 'Copy'), 1200);
      } else if (action === 'insert') {
        send({ type: 'code/insert', code: stripPathComment(code) });
      } else if (action === 'apply' && block?.dataset.path) {
        send({ type: 'code/apply', tabId, path: block.dataset.path, code: stripPathComment(code) });
      } else if (action === 'open' && block?.dataset.cite) {
        const [a, b, ...p] = block.dataset.cite.split(':');
        send({ type: 'file/open', path: p.join(':'), line: Number(a), endLine: Number(b) });
      }
      return;
    }
    const a = target.closest('a');
    const href = a?.getAttribute('data-href');
    if (!a || !href) return;
    if (/^(https?|mailto):/i.test(href)) return; // VS Code opens these externally
    e.preventDefault();
    const m = /^(?:file:\/\/\/?)?(.+?)(?:#L(\d+)(?:-L?(\d+))?)?$/.exec(decodeURI(href));
    if (m) send({ type: 'file/open', path: m[1]!, line: m[2] ? Number(m[2]) : undefined, endLine: m[3] ? Number(m[3]) : undefined });
  };

  return (
    <div className={`markdown${streaming ? ' streaming' : ''}`} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
  );
});
