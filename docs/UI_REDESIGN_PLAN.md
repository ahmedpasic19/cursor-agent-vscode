# Cursor Agent: Claude Code–style visual redesign (plan)

Goal: the chat panel should look and behave like the Claude Code extension, so a user
switching between the two doesn't notice the difference. Only the mascot and the accent color
say "Cursor".

## Decisions (from Q&A, 2026-11-05)

| Topic | Decision |
|---|---|
| Mascot | Pixel-art **cube critter**: Cursor's isometric cube as the body, eyes, two little legs. It blinks when idle and bobs while a run is going. |
| Colors | **Claude's palette** (grays, borders, radii, type scale, spacing) with a **Cursor accent**: neutral off-white/silver instead of Claude's coral. |
| Transcript | **Claude-style dot timeline**: no boxes, one line per tool, IN/OUT collapsed, and runs of reads/searches grouped ("Read 6 files"). |
| History button | **Session dropdown inside the chat panel**: searchable list of past sessions, click to resume. |
| Settings gear | Removed from the chat header. Settings stay on the left (Sessions view). |

---

## 1. Design tokens (`webview-ui/src/theme.css`, new)

One token file shared by the chat and Sessions webviews. Every color is still derived from
VS Code theme variables, so light/high-contrast themes keep working. Claude's look comes from the
radii, the subtle borders and the layering, not from hard-coded hex values.

```css
:root {
  --ca-bg:            var(--vscode-sideBar-background);
  --ca-surface:       color-mix(in srgb, var(--vscode-foreground) 4%, var(--ca-bg));   /* popups, input */
  --ca-surface-hover: color-mix(in srgb, var(--vscode-foreground) 8%, var(--ca-bg));
  --ca-border:        color-mix(in srgb, var(--vscode-foreground) 14%, transparent);
  --ca-border-strong: color-mix(in srgb, var(--vscode-foreground) 28%, transparent);
  --ca-text:          var(--vscode-foreground);
  --ca-muted:         var(--vscode-descriptionForeground);
  --ca-accent:        #e8e6e3;  /* Cursor off-white (dark themes) */
  --ca-accent-ink:    #1b1b1b;
  --ca-ok:            var(--vscode-testing-iconPassed, #3fb950);
  --ca-err:           var(--vscode-errorForeground);
  --ca-radius-sm: 4px; --ca-radius: 6px; --ca-radius-lg: 10px;
  --ca-font-mono: var(--vscode-editor-font-family);
}
body.vscode-light { --ca-accent: #2b2b2b; --ca-accent-ink: #fff; }
```

Remove the per-mode tinting of the composer (`.composer.mode-*` colored borders) and the colored
`mode-badge` on user messages. Claude shows neither.

## 2. Chat header (`ChatHeader.tsx`)

`[title …………] [bookmark?] [🕘] [+]`. Same as Claude: plain title, no gear.

- Drop the ⚙ button.
- Clock opens the new **HistoryDropdown** (§6) instead of revealing the left view.
- Larger hit targets (24px), codicon-weight SVG icons from `sessions/icons.tsx`.

## 3. Empty state (`App.tsx`) + mascot

Claude shows only the mascot and one hint line. We'll do the same:

- Centered `<Mascot />` (≈48px), then one muted rotating tip, e.g. "Type /model to pick the right
  model for the job", "Shift+Tab switches Agent · Ask · Plan", "Type @ to attach files".
- The long explanation and the shortcuts table move to a `/help` popup. They don't show by default.

### Mascot (`webview-ui/src/components/Mascot.tsx`, new)

- Inline SVG on a 16×16 pixel grid (`shape-rendering: crispEdges`). The cube body has three shaded
  faces (light top, mid left, dark right, like the Cursor mark), two eyes on the front faces, and
  two 1-px legs.
- States: `idle` blinks every ~4 s (eyes swap to a 1-px line for 120 ms). `working` bobs 1 px
  and the legs alternate. `done` hops once. All CSS keyframes, disabled under
  `prefers-reduced-motion`.
- Reused small (14px) as the "working" indicator in the timeline and the header running dot.

## 4. Composer (`Composer.tsx`)

Match Claude's input box:

```
┌──────────────────────────────────────────────────┐
│ ctrl+esc to focus or unfocus Cursor          🎙? │  ← placeholder, multiline
│                                                  │
│ [+] [/]  (Opus 4.1 · Agent)    </> Agent    [↑]  │
└──────────────────────────────────────────────────┘
```

- One rounded (10px) bordered box, focus ring = `--ca-border-strong`, no colored border.
- Bottom row, left: `+` (attach file/selection/problems menu), `/` (slash commands), a **model
  pill** (rounded chip, shows the model name). Right: the **mode button** (icon + label) and a round
  send button (↑). The send button becomes ■ stop while running.
- The worktree checkbox moves into the `+` menu as a toggle item, with a small ⎇ chip when it's
  on. That's one less control on the bar.
- The status text ("Running… (Esc to stop)") goes. The stop button and the mascot cover it.

## 5. Model and mode popups

Both use one new `<Popover>` component: opens above the composer, `--ca-surface` background,
1px `--ca-border`, 8px radius, a soft shadow, keyboard nav, and closes on Esc or an outside click.

**Model popover (`ModelSelect.tsx`)**
- Header line (muted): `<current> · <its description>`.
- Rows are two lines: **label**, then a muted one-line description. A ✓ on the right marks the
  current model, and the active row gets a `--ca-surface-hover` fill.
- Descriptions come from a small table in `webview-ui/src/modelInfo.ts` keyed by model-id pattern
  (e.g. `/opus/` → "For complex work and everyday tasks", `/sonnet/` → "Efficient for routine
  tasks", `/gpt-5/`, `/gemini/`, `/grok/`, `-thinking` suffix → "Extended reasoning",
  `auto` → "Cursor picks the model"). Unknown ids show no description.
- The filter box appears only once you start typing (Claude has none visible). Typing filters the
  list in place, and the "Use custom id" row stays.
- The ↻ reload moves into the popup footer as a small "Refresh models" link.
- Footer row "Effort": **left out**. The Cursor CLI has no effort flag. A `-thinking` model
  variant is the closest thing, and it's already a separate row.

**Mode popover (new `ModePopover`, replaces the native `<select>`)**
- Header: "Modes", with a muted `⇧ + tab to switch` on the right.
- Rows: icon + title + description + ✓:
  - Agent (`</>`): "Edits files and runs commands automatically"
  - Ask (💬 outline): "Read-only: answers questions, changes nothing"
  - Plan (☰): "Explores the code and presents a plan before editing"
- If the CLI has no `--mode` flag, Ask and Plan show as disabled with "Needs a newer cursor-agent".

## 6. History dropdown (fixes "chat history doesn't work on the right")

Today the clock sends `sessions/show`, which only reveals the left view. That fails when the
primary sidebar is collapsed, or when the chat is in the fallback location.

- Host: also post `sessions/state` (rows + activeId) to the **chat** bridge whenever it's pushed
  to the Sessions bridge. The chat store keeps `rows`.
- Allow `session/open` from the chat webview (route it to the same `openSession` handler in
  `extension.ts`).
- UI: a popover under the clock with a search box, rows grouped "Today / Yesterday / Last 7 days /
  Older", the title plus a relative time, a running dot when active, and the current session
  highlighted. Enter or click opens the session, Esc closes.
- `/history` and the `cursorAgent.showHistory` command open this dropdown (new host→webview
  message `history/open`) instead of revealing the left view.

## 7. Transcript: "way less trash"

**User message:** a rounded `--ca-surface` bubble (no mode badge). Attachment chips sit above
the text as small pills. "Restore code to before this message" becomes a hover-only icon button
(↶) on the bubble's top right, with a tooltip.

**Timeline (`RunMessage.tsx` + `ToolCard.tsx`):**
- A thin vertical rail at the left, with each item a dot: grey = done, pulsing = running, red =
  error. No card borders and no backgrounds.
- One line per tool: **bold verb** + muted target, e.g. **Read** `src/App.tsx`,
  **Bash** `npm test`, **Edit** `styles.css` `+12 −3`.
- Bash: clicking expands a Claude-style IN/OUT block (two rows labelled `IN` / `OUT`, mono,
  max 8 lines with a "show more").
- Edit/Write: expand to the mini diff, as today.
- **Grouping:** 2+ consecutive read-only tools (read, search, glob, list) collapse into one line,
  "Read 6 files, searched 2 patterns", which expands to the individual lines. Pure UI, done
  in a `groupBlocks(blocks)` helper in `transcript.ts` (tested).
- **Thinking:** no "Thought for 7s ▸" rows. A muted italic "Thinking" line with a dot that
  expands to the text. Consecutive thinking blocks merge.
- Text blocks: plain markdown on the rail, a slightly larger line-height (1.55), like Claude.
- The run footer (model · duration · tokens) becomes a hover-only muted line. The Changes card is
  restyled to the same surface/border tokens (kept, since it's a real feature).
- Plan/Todo cards: keep them, restyled with the tokens and a ✓/○ checklist like Claude's task
  list.

## 8. Sessions view (left)

Apply the same tokens to `sessions.css` so both sides match: subtle borders, 6px radii, muted
section headers, the mascot-style running dot. The settings gear lives here (`view/title` menu
→ `workbench.action.openSettings cursorAgent`).

## 9. Extension icons

- `media/icon.svg` (activity bar, monochrome `currentColor`): replace the outline cube with a
  **filled Cursor-style mark**: a hexagon cube where one face is cut by the diagonal "pointer"
  facet, drawn with `fill="currentColor"` and a cut-out, so VS Code can tint it.
- `media/logo.png` (128×128, marketplace/extension list): full-color version (dark rounded square,
  off-white shaded cube), rendered from `media/logo.svg` with a one-off script
  (`scripts/render-logo.mjs`, using `@resvg/resvg-js` as a devDependency). Add `"icon":
  "media/logo.png"` to `package.json`.
- Note: this mimics Cursor's logo. It's fine for a local/personal build. Don't publish it to the
  public Marketplace under that mark.

## 10. Implementation order

1. Tokens + base styles (`theme.css`), and strip the mode tinting and badges.
2. Popover primitive, then the model popover, mode popover and composer bar.
3. Mascot + empty state.
4. Header cleanup + history dropdown (host + webview + protocol + tests).
5. Timeline transcript + grouping helper (unit tests for `groupBlocks`).
6. Sessions view restyle + gear on the left.
7. Icons + logo render script.
8. Verify: `npm run build`, `npm test`, then side-by-side screenshots in the Extension Host with
   Dark Modern, Light Modern and High Contrast.

## Out of scope

- An Effort control (no CLI support).
- Voice input (the 🎙 in Claude's composer).
- Changing what data is shown. This is visual and interaction work only, apart from the history
  wiring.
