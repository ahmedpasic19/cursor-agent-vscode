/**
 * DOM helpers for the composer's contenteditable input. The composer's source of truth is a
 * string in which inline chips are tokens (see src/shared/inlineChips.ts); these helpers convert
 * between that string, the DOM, and caret offsets measured in that string.
 */
import type { ContextChip } from '../../../src/shared/protocol';
import { chipLabel, chipToken, CHIP_TOKEN_RE } from '../../../src/shared/inlineChips';
import { CHIP_ICON, chipTooltip } from './ContextChips';

const BLOCK = new Set(['DIV', 'P', 'LI']);

function chipIdOf(n: Node): string | undefined {
  return n instanceof HTMLElement ? n.dataset.chip : undefined;
}

/** Serialized length of one node (used for caret math). */
function nodeLength(n: Node): number {
  return serializeNode(n, '').length;
}

function serializeNode(n: Node, before: string): string {
  if (n.nodeType === Node.TEXT_NODE) return (n.textContent ?? '').replace(/​/g, '');
  const id = chipIdOf(n);
  if (id) return chipToken(id);
  if (n.nodeName === 'BR') return '\n';
  let out = '';
  // Chrome wraps lines in <div> when the user types Enter in odd ways; treat a block as a new line.
  if (BLOCK.has(n.nodeName) && (before + out).length && !(before + out).endsWith('\n')) out += '\n';
  for (const c of n.childNodes) out += serializeNode(c, before + out);
  return out;
}

/** The input's value as a token string. */
export function serialize(root: Node): string {
  let out = '';
  const kids = [...root.childNodes];
  // A trailing <br> is the placeholder that makes a final empty line visible, not content.
  if (kids.length && kids[kids.length - 1]!.nodeName === 'BR' && root instanceof HTMLElement) kids.pop();
  for (const c of kids) out += serializeNode(c, out);
  return out;
}

/** Caret position (in the token string), or undefined when the selection is outside `el`. */
export function getCaret(el: HTMLElement): number | undefined {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || !el.contains(sel.focusNode)) return undefined;
  const r = document.createRange();
  r.setStart(el, 0);
  r.setEnd(sel.focusNode!, sel.focusOffset);
  return serialize(r.cloneContents()).length;
}

/** Put the caret at `offset` in the token string. */
export function setCaret(el: HTMLElement, offset: number): void {
  const sel = window.getSelection();
  if (!sel) return;
  const r = document.createRange();
  let left = offset;
  let placed = false;
  for (const n of el.childNodes) {
    const len = nodeLength(n);
    if (n.nodeType === Node.TEXT_NODE && left <= len) {
      r.setStart(n, left);
      placed = true;
      break;
    }
    if (left < len) {
      // Inside a chip or other element: put the caret after it.
      r.setStartAfter(n);
      placed = true;
      break;
    }
    left -= len;
    if (left === 0) {
      r.setStartAfter(n);
      placed = true;
      break;
    }
  }
  if (!placed) {
    r.selectNodeContents(el);
    r.collapse(false);
  }
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
}

/** DOM for one inline chip. */
export function chipElement(c: ContextChip, removable: boolean): HTMLElement {
  const span = document.createElement('span');
  span.className = `chip chip-inline chip-${c.kind}`;
  span.contentEditable = 'false';
  span.dataset.chip = c.id;
  span.title = chipTooltip(c);
  if (c.kind === 'image' && c.thumb) {
    const img = document.createElement('img');
    img.className = 'chip-thumb';
    img.src = c.thumb;
    img.alt = '';
    span.append(img);
  } else {
    const icon = document.createElement('span');
    icon.className = 'chip-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = CHIP_ICON[c.kind];
    span.append(icon);
  }
  const label = document.createElement('span');
  label.className = 'chip-label';
  label.textContent = chipLabel(c);
  span.append(label);
  if (removable) {
    const x = document.createElement('span');
    x.className = 'chip-x';
    x.dataset.remove = c.id;
    x.setAttribute('role', 'button');
    x.setAttribute('aria-label', `Remove ${chipLabel(c)}`);
    x.textContent = '×';
    span.append(x);
  }
  return span;
}

/** Replace the input's content with `value` (tokens rendered as chips; unknown chips dropped). */
export function render(el: HTMLElement, value: string, chips: ContextChip[]): void {
  const byId = new Map(chips.map((c) => [c.id, c]));
  const frag = document.createDocumentFragment();
  let last = 0;
  for (const m of value.matchAll(CHIP_TOKEN_RE)) {
    if (m.index! > last) frag.append(document.createTextNode(value.slice(last, m.index)));
    const c = byId.get(m[1]!);
    if (c) frag.append(chipElement(c, true));
    last = m.index! + m[0].length;
  }
  if (last < value.length) frag.append(document.createTextNode(value.slice(last)));
  // A trailing newline needs something after it to show as an empty line.
  if (value.endsWith('\n')) frag.append(document.createElement('br'));
  el.replaceChildren(frag);
}
