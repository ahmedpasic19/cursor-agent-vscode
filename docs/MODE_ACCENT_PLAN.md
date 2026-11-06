# Mode-coloured composer (border + send button)

**Goal.** Like Claude Code: the composer tells you which mode you are in before you read the label.
Each mode gets its own accent; the border **lights up only while the composer is focused** (Cursor's
behaviour — unfocused it stays a quiet hint of the colour), the send button carries the accent all the
time, and switching mode plays one short pulse so `Shift+Tab` is visible without looking at the pill.

Scope: webview CSS + two small React changes. No host/protocol/CLI work.

---

## 1. Palette — three distinct, matching accents, no blue

Hues spread evenly around the wheel but skipping the blue arc (200°–265°), all at the same muted
saturation/lightness so they read as one family. Dark-theme values first, light-theme variants
darkened ~12% for contrast on a white input background.

| Mode | Meaning | Dark `--ca-mode` | Light `--ca-mode` | Ink (on button) |
| --- | --- | --- | --- | --- |
| `agent` | edits files, runs commands | `#d97757` terracotta | `#b85c3c` | `#1a1008` |
| `ask` | read-only Q&A | `#86a96b` sage | `#5f8347` | `#0d1408` |
| `plan` | explores, proposes | `#a77ab8` mauve | `#86589a` | `#150d18` |

Each mode defines three tokens, set on `.composer-box` by a `data-mode` attribute (not on `:root`, so
the colour is scoped to the composer and future per-tab composers just work):

```css
/* theme.css — after the existing accent block */
[data-mode='agent'] { --ca-mode: #d97757; --ca-mode-ink: #1a1008; }
[data-mode='ask']   { --ca-mode: #86a96b; --ca-mode-ink: #0d1408; }
[data-mode='plan']  { --ca-mode: #a77ab8; --ca-mode-ink: #150d18; }
body.vscode-light [data-mode='agent'] { --ca-mode: #b85c3c; --ca-mode-ink: #fff; }
body.vscode-light [data-mode='ask']   { --ca-mode: #5f8347; --ca-mode-ink: #fff; }
body.vscode-light [data-mode='plan']  { --ca-mode: #86589a; --ca-mode-ink: #fff; }
```

Derived, so there is one knob per mode:

```css
.composer-box {
  --ca-mode-rest: color-mix(in srgb, var(--ca-mode) 32%, var(--ca-border-strong));
  --ca-mode-lit: var(--ca-mode);
  --ca-mode-glow: color-mix(in srgb, var(--ca-mode) 22%, transparent);
}
```

High contrast keeps VS Code's own border — `body.vscode-high-contrast .composer-box { --ca-mode-rest: var(--ca-border-strong); }`,
and the lit border falls back to `--vscode-contrastActiveBorder`.

Fallback: when `modesSupported` is false (old CLI, Agent only) nothing changes visually — Agent's
accent is simply always on, which is correct.

---

## 2. Border: quiet at rest, lit on focus

Replaces the two rules at [styles.css:1318-1331](../webview-ui/src/styles.css#L1318-L1331). The
current focus rule (neutral foreground mix + 1px ring) becomes the mode-tinted version; the rest state
only hints at the colour, so an unfocused composer still looks like VS Code chrome.

```css
.composer-box {
  border: 1px solid var(--ca-mode-rest);          /* was --ca-border-strong */
  transition: border-color 0.16s ease, box-shadow 0.16s ease;
}
.composer-box:focus-within {
  border-color: var(--ca-mode-lit);
  box-shadow: 0 0 0 1px var(--ca-mode-glow);      /* the "light up" ring */
}
```

`.composer-box.drag-over` ([styles.css:1524](../webview-ui/src/styles.css#L1524)) keeps
`--vscode-focusBorder` — the drop state should win over the mode colour. `.disabled` keeps its
`opacity: 0.6`, which dims the tint for free.

---

## 3. Send button + mode pill

- `.send-btn.ready` ([styles.css:1450](../webview-ui/src/styles.css#L1450)) swaps
  `var(--ca-accent)`/`var(--ca-accent-ink)` for `var(--ca-mode)`/`var(--ca-mode-ink)`. Because the
  button is tinted even when the composer is blurred, mode stays readable at rest (matching screenshot 2,
  where the orange button reads as "Auto" at a glance).
- `.send-btn:not(.ready)` (nothing typed) stays `--ca-surface-2` — no shouting at an empty composer.
- `.send-btn.stop` (running) stays `--ca-text`/`--ca-bg`: stop must not look like a mode.
- `.mode-button svg { color: var(--ca-mode); }` so the pill's icon matches the border. The label text
  stays `--ca-muted`; colouring both made the bar noisy in the Claude Code reference.
- `ModeSelect`'s popover rows are untouched — `data-mode` lives on the composer box, and the popover
  renders inside it, so each row's `current` tick inherits the active mode colour only.

---

## 4. The switch pulse

One animation, retriggered on every mode change (including `Shift+Tab`, `/mode`, and the popover).

```css
@keyframes composer-mode-pulse {
  0%   { border-color: var(--ca-mode-lit); box-shadow: 0 0 0 3px var(--ca-mode-glow); }
  100% { border-color: inherit;            box-shadow: 0 0 0 1px transparent; }
}
.composer-box.mode-pulse { animation: composer-mode-pulse 420ms ease-out 1; }
@media (prefers-reduced-motion: reduce) {
  .composer-box.mode-pulse { animation: none; }
}
```

React side, in [Composer.tsx](../webview-ui/src/components/Composer.tsx). The box carries the mode:

```tsx
// Composer.tsx:443 — same element, one new attribute + one class segment
<div
  data-mode={mode}
  className={`composer-box${disabled ? ' disabled' : ''}${drag === 'drop' ? ' drag-over' : ''}${pulsing ? ' mode-pulse' : ''}`}
  ...
>
```

Retriggering the animation must **not** be done with a changing `key` — remounting the box would
destroy the contentEditable child and lose the caret and draft DOM. Toggle the class off and back on
across a frame instead:

```tsx
const [pulsing, setPulsing] = useState(false);
const firstMode = useRef(true);   // no pulse on mount or tab switch
useEffect(() => {
  if (firstMode.current) { firstMode.current = false; return; }
  setPulsing(false);
  const raf = requestAnimationFrame(() => setPulsing(true));
  const t = setTimeout(() => setPulsing(false), 460);
  return () => { cancelAnimationFrame(raf); clearTimeout(t); };
}, [mode]);
```

The cleanup makes a rapid `Shift+Tab Shift+Tab` restart the animation rather than stack it.

---

## 5. Files touched

| File | Change |
| --- | --- |
| `webview-ui/src/theme.css` | `[data-mode=…]` token blocks, dark + light + high-contrast |
| `webview-ui/src/styles.css` | `.composer-box` rest/focus border, derived tokens, `.send-btn.ready`, `.mode-button svg`, `composer-mode-pulse` keyframes + reduced-motion |
| `webview-ui/src/components/Composer.tsx` | `data-mode={mode}`, pulse state + class (~10 lines) |

Nothing in `src/` (host), no protocol change, no new setting. `ModeSelect.tsx` is unchanged.

---

## 6. Verification

1. `npm run build` (or the webview dev harness `webview-ui/harness.html`) — the harness renders the
   composer standalone, so all three modes can be eyeballed without the CLI.
2. Manual pass in the sidebar: `Shift+Tab` through agent → ask → plan and confirm (a) border is a
   quiet tint when the composer is blurred, (b) it lights up with the ring on focus, (c) the button
   recolours immediately, (d) one pulse per switch.
3. Light theme and a high-contrast theme: border must stay legible; HC keeps VS Code's contrast border.
4. `npm test` — no snapshot covers composer classes today, so nothing should break; if
   `test/integration/polish.ts` gains a class assertion later, add `data-mode` there.
5. Check the running state: start a run and confirm the stop button is neutral, not mode-tinted.

---

## 7. Deliberately out of scope

- Colouring the transcript, tab bar, or the Sessions webview by mode.
- A user-configurable palette (`cursorAgent.modeColors`) — easy later, the tokens are already the
  single source of truth.
- Reflecting the host-side `tab.meta.mode` anywhere outside the composer.
