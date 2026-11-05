/**
 * Syntax highlighting with Shiki (fine-grained bundle, JS regex engine: no WASM, so the strict
 * webview CSP needs no 'wasm-unsafe-eval'). Emits Dark+/Light+ colors as CSS variables; the
 * stylesheet picks one from VS Code's body class (vscode-dark / vscode-light / high contrast).
 */
import { createHighlighterCore, type HighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';

let hl: HighlighterCore | undefined;
const listeners = new Set<() => void>();

const ALIASES: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  sh: 'shellscript',
  shell: 'shellscript',
  zsh: 'shellscript',
  console: 'shellscript',
  ps1: 'powershell',
  ps: 'powershell',
  pwsh: 'powershell',
  py: 'python',
  yml: 'yaml',
  md: 'markdown',
  // C++ maps to the C grammar: the C++ one (with its embedded grammars) adds ~500 KB.
  cpp: 'c',
  'c++': 'c',
  cc: 'c',
  hpp: 'c',
  h: 'c',
  cs: 'csharp',
  'c#': 'csharp',
  rs: 'rust',
  golang: 'go',
  htm: 'html',
  svg: 'xml',
  jsonc: 'json',
  json5: 'json',
  patch: 'diff',
  docker: 'dockerfile',
};

export const highlighterReady: Promise<void> = createHighlighterCore({
  themes: [import('@shikijs/themes/dark-plus'), import('@shikijs/themes/light-plus')],
  langs: [
    import('@shikijs/langs/typescript'),
    import('@shikijs/langs/tsx'),
    import('@shikijs/langs/javascript'),
    import('@shikijs/langs/jsx'),
    import('@shikijs/langs/json'),
    import('@shikijs/langs/shellscript'),
    import('@shikijs/langs/powershell'),
    import('@shikijs/langs/python'),
    import('@shikijs/langs/css'),
    import('@shikijs/langs/html'),
    import('@shikijs/langs/markdown'),
    import('@shikijs/langs/yaml'),
    import('@shikijs/langs/diff'),
    import('@shikijs/langs/go'),
    import('@shikijs/langs/rust'),
    import('@shikijs/langs/java'),
    import('@shikijs/langs/c'),
    import('@shikijs/langs/csharp'),
    import('@shikijs/langs/sql'),
    import('@shikijs/langs/xml'),
    import('@shikijs/langs/toml'),
    import('@shikijs/langs/dockerfile'),
    import('@shikijs/langs/ini'),
  ],
  engine: createJavaScriptRegexEngine({ forgiving: true }),
})
  .then((h) => {
    hl = h;
    listeners.forEach((l) => l());
  })
  .catch((e) => console.warn('[cursor-agent] highlighter failed to load', e));

export function onHighlighterReady(fn: () => void): () => void {
  if (hl) fn();
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function isHighlighterReady(): boolean {
  return !!hl;
}

export function resolveLang(lang: string | undefined): string | undefined {
  if (!lang || !hl) return undefined;
  const l = lang.toLowerCase();
  const id = ALIASES[l] ?? l;
  return hl.getLoadedLanguages().includes(id) ? id : undefined;
}

/** Highlighted `<pre class="shiki">…</pre>`, or undefined (not loaded / unknown language / too big). */
export function highlight(code: string, lang: string | undefined): string | undefined {
  const id = resolveLang(lang);
  if (!hl || !id || code.length > 200_000) return undefined;
  try {
    return hl.codeToHtml(code, { lang: id, themes: { light: 'light-plus', dark: 'dark-plus' }, defaultColor: false });
  } catch {
    return undefined;
  }
}
