import MarkdownIt from 'markdown-it';
import { memo, useMemo, type MouseEvent } from 'react';
import { send } from '../vscode';

const md = new MarkdownIt({ html: false, linkify: true, breaks: false });

// Open links outside the webview; file links open in the editor.
const defaultLink = md.renderer.rules.link_open ?? ((t, i, o, _e, s) => s.renderToken(t, i, o));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx]!.attrSet('data-href', tokens[idx]!.attrGet('href') ?? '');
  return defaultLink(tokens, idx, options, env, self);
};

function onClick(e: MouseEvent<HTMLDivElement>) {
  const a = (e.target as HTMLElement).closest('a');
  const href = a?.getAttribute('data-href');
  if (!a || !href) return;
  if (/^(https?|mailto):/i.test(href)) return; // VS Code opens these externally
  e.preventDefault();
  const m = /^(?:file:\/\/\/?)?(.+?)(?:#L(\d+))?$/.exec(decodeURI(href));
  if (m) send({ type: 'file/open', path: m[1]!, line: m[2] ? Number(m[2]) : undefined });
}

export const Markdown = memo(function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
  const html = useMemo(() => md.render(text), [text]);
  return (
    <div
      className={`markdown${streaming ? ' streaming' : ''}`}
      onClick={onClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
});
