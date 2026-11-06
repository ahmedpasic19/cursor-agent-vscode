# Effort meter — plan

Add a Claude Code–style **Effort** meter to the composer, shown in the footer of both the model
popover and the mode popover, exactly as in the reference screenshots.

Status: **planned**, not implemented. Decisions below are settled (confirmed with the user).

---

## 1. The key finding: Cursor encodes effort in the model id

`cursor-agent` has **no `--effort` flag** (see [CLI_NOTES.md §2](CLI_NOTES.md)). But the model list
does the job for us. From `test/fixtures/invalid-model.stderr.txt` (the CLI's own "Available models"
dump, ~270 ids):

```
claude-opus-5-5-low        claude-opus-5-5-low-fast
claude-opus-5-5-medium     claude-opus-5-5-medium-fast
claude-opus-5-5-high       claude-opus-5-5-high-fast
claude-opus-5-5-xhigh      claude-opus-5-5-xhigh-fast
claude-opus-5-5-max        claude-opus-5-5-max-fast
gpt-5.5-none  gpt-5.5-low  gpt-5.5-medium  gpt-5.5-high  gpt-5.5-extra-high
muse-wonder-1.0-minimal … -low -medium -high -xhigh -max
claude-opus-5-thinking-low … -medium -xhigh -max
claude-4.6-sonnet-medium-thinking      ← legacy token order
claude-4.6-opus-high-thinking
gemini-3.1-pro, composer-2.5, auto, kimi-k2.7-code   ← no effort variants at all
```

So **effort = a suffix token on the id**, and the "family" is the id with that token removed.
The meter therefore does something real: it swaps `tab.model` to the sibling id in the same family.
No new CLI flag, no prompt hacks, no SDK change.

Observed effort tokens and their rank:

| token | rank |
|---|---|
| `none` | 0 |
| `minimal` | 1 |
| `low` | 2 |
| `medium` | 3 |
| `high` | 4 |
| `extra-high`, `xhigh` | 5 |
| `max` | 6 |

Orthogonal modifiers that are **not** effort and must survive the swap: `-fast` (always trailing)
and `thinking` (usually an infix, `…-thinking-<effort>`; legacy ids put it last,
`…-<effort>-thinking`).

---

## 2. Decisions

| Question | Decision |
|---|---|
| What does the meter change? | Swaps the selected model to its sibling id in the same family. Greyed out for families with ≤1 effort variant (`auto`, `composer-2.5`, `gpt-5.1`, …) and for "Default model". |
| Where does it live? | A row pinned in the **footer of both popovers** — model and mode — matching the screenshots. |
| Persistence | Per tab. Achieved for free: the full id lives in `tab.model`, which is already per-tab and persisted. A separate *preferred* effort is remembered in webview `localStorage` so it carries across model switches. |
| Scale | 4 steps: **Low / Medium / High / Max**, default Medium — rendered as the filled pill + 3 dots from the screenshot. |

### Why no `tab/setEffort` protocol message

Rejected alternative: store `{family, effort}` separately on the tab and compose the id at send time.
That means touching `protocol.ts`, `TabSession`, `HistoryStore`, `extension.ts`, the SDK worker and
every snapshot — for a value that is already fully determined by `tab.model`.

Chosen instead: **the id stays the single source of truth.** The meter calls the existing
`onModelChange` / `tab/setModel` with the sibling id. Effort for display is *derived* from the id.
Zero protocol, extension-host or storage changes; the whole feature is webview-side.

The one thing the derivation loses is intent across family switches ("I'm a max-effort person").
That is covered by a sticky preference in `localStorage`, next to `recentModels`.

---

## 3. New module: `webview-ui/src/effort.ts`

Pure functions, unit-testable without a DOM.

```ts
export type Effort = 'low' | 'medium' | 'high' | 'max';          // UI steps
export const EFFORTS: Effort[] = ['low', 'medium', 'high', 'max'];

export interface ParsedModel {
  /** Id with the effort token removed, modifiers kept: "claude-opus-5-5", "claude-opus-5-thinking". */
  family: string;
  /** Raw CLI token, e.g. "xhigh" | "extra-high"; undefined when the id has none. */
  token?: string;
  rank?: number;        // 0..6, from the table above
  fast: boolean;        // trailing "-fast" was stripped
  legacyThinkingLast: boolean; // id was "<family>-<effort>-thinking"
}

export function parseModelId(id: string): ParsedModel;
```

Parsing order (strict, so we never mangle an id we don't understand):

1. Strip a trailing `-fast` → `fast = true`.
2. Strip a trailing `-thinking` → `legacyThinkingLast = true`.
3. Match a trailing effort token against the known set (`max|xhigh|extra-high|high|medium|low|minimal|none`,
   longest-first so `extra-high` wins over `high`). If none matches, return `{ family: <rest>, fast }`
   with no token — the meter is disabled for this id.
4. Re-append `-thinking` to the family when `legacyThinkingLast`, so the family is reconstructable.

```ts
/** Effort tokens that actually exist for this family, from the live model list, ranked ascending. */
export function familyTokens(models: ModelOption[], family: string, fast: boolean): string[];

/** The 4 UI steps mapped onto what this family really offers. */
export function effortLadder(tokens: string[]): Record<Effort, string | undefined>;

/** Compose the id to send: family + chosen token + modifiers. */
export function modelForEffort(models: ModelOption[], id: string, e: Effort): string | undefined;

/** Which UI step the current id sits on (for the filled dots). */
export function effortOf(models: ModelOption[], id: string | undefined): Effort | undefined;
```

**Ladder mapping.** Target ranks are Low→2, Medium→3, High→4, Max→6. For each step pick the
available token with the nearest rank; on a tie pick the higher. Examples:

| family | available tokens | Low | Medium | High | Max |
|---|---|---|---|---|---|
| `claude-opus-5-5` | low, medium, high, xhigh, max | low | medium | high | max |
| `gpt-5.5` | none, low, medium, high, extra-high | low | medium | high | extra-high |
| `muse-wonder-1.0` | minimal, low, medium, high, xhigh, max | low | medium | high | max |
| `claude-opus-5-thinking` | low, medium, xhigh, max | low | medium | xhigh | max |
| `kimi-k3` | low, high, max | low | low | high | max |
| `composer-2.5` | — | disabled (meter greyed, tooltip "This model has one effort level") |

`modelForEffort` must verify the composed id exists in the model list before returning it; otherwise
return `undefined` and leave the model unchanged. This keeps us safe if Cursor renames tokens —
a wrong id makes the CLI exit 1 with empty stdout ([CLI_NOTES.md §6](CLI_NOTES.md)).

**Sticky preference** (same shape as `recentModels` in [modelInfo.ts](../webview-ui/src/modelInfo.ts)):

```ts
export function preferredEffort(): Effort;            // localStorage 'cursorAgent.effort', default 'medium'
export function rememberEffort(e: Effort): void;
```

When the user picks a model in `ModelSelect`, the id actually sent is
`modelForEffort(models, picked.id, preferredEffort()) ?? picked.id` — so choosing "Opus 5.5" while
set to Max sends `claude-opus-5-5-max`, matching how Claude Code keeps effort across model changes.

---

## 4. New component: `webview-ui/src/components/EffortMeter.tsx`

```tsx
interface Props {
  models: ModelOption[];
  model?: string;             // current full id ("Default" when undefined)
  onChange(model: string): void;  // emits the sibling id
}
```

Renders the screenshot's row: `⚖ Effort (Medium)` on the left, the dot track on the right.

- Track = 4 hit targets. The **active** one is a filled rounded pill (`--ca-accent`), the others are
  small muted dots, so Low shows `●···`, Max shows `···●` — same visual language as the screenshot.
- Disabled state (no variants / Default model): dots at 20% opacity, no pointer events,
  `title` explains why. The row stays visible so the layout doesn't jump.
- Click a dot → `onChange(modelForEffort(...))`, plus `rememberEffort`.
- `←` / `→` while the row has focus steps the meter; the row is one tab stop
  (`role="slider"`, `aria-valuemin/max/now/text`), so arrows don't fight the list's `↑`/`↓`.
- The icon is a new `EffortIcon` in [sessions/icons.tsx](../webview-ui/src/sessions/icons.tsx) —
  the sliders/meter glyph from the screenshot (two vertical ticks on a horizontal rail), 14px,
  `currentColor`, matching the existing icon set.

---

## 5. Wiring

### `Popover.tsx`
No change needed — it already takes a `footer` node and renders `.popover-footer`.
One tweak: `ModelSelect` already uses `footer` for "N models · Refresh", so that popover needs the
meter **above** the existing footer. Add an optional `secondaryFooter?: ReactNode` rendered as a
second `.popover-footer` row (border-top, same padding) between the list and the footer.

### `ModelSelect.tsx` ([webview-ui/src/components/ModelSelect.tsx](../webview-ui/src/components/ModelSelect.tsx))
- Pass `secondaryFooter={<EffortMeter models={models} model={value} onChange={onChange} />}`.
- In `pick()`, apply the sticky effort when the picked id is a bare family
  (`modelForEffort(models, o.id, preferredEffort()) ?? o.id`). Skip for the custom-id row and for
  `Default`.
- `labelOf` in the composer pill should show the **family label**, not the raw variant, so the pill
  reads "Opus 5.5" rather than "Opus 5.5 Max" — the effort already has its own indicator.

### `ModeSelect.tsx` ([webview-ui/src/components/ModeSelect.tsx](../webview-ui/src/components/ModeSelect.tsx))
- New props `models`, `model`, `onModelChange`, threaded from `Composer`.
- `footer={<EffortMeter … />}` — in this popover it is the only footer, matching screenshot 3.
- The `onKey` handler gains `←`/`→` so the meter is reachable without leaving the mode list.

### `Composer.tsx` ([webview-ui/src/components/Composer.tsx:592-605](../webview-ui/src/components/Composer.tsx#L592-L605))
- Pass `models` / `model` / `props.onModelChange` down to `ModeSelect`.
- No change to the composer row itself: the meter lives only in the popovers.

### Model list collapsing (part of this change)
With the meter in place, listing all 270 ids *and* an effort control is contradictory — the user
would see `claude-opus-5-5-low … -max` as five separate rows. So `ModelSelect`'s unfiltered list
groups by `parseModelId().family` and shows **one row per family** (label taken from the
mid-effort variant, `-fast` variants folded in as a separate family as the CLI treats them).

Escape hatch: typing in the filter keeps searching **all raw ids**, unchanged, so a specific
variant is always reachable by typing it. The footer count becomes
`"N models · M families · type to filter"`.

### CSS ([webview-ui/src/styles.css](../webview-ui/src/styles.css), near `.popover-footer` at line 294)
New rules: `.effort-row`, `.effort-label`, `.effort-track`, `.effort-dot`, `.effort-dot.on`,
`.effort-row.disabled`. All colors from existing vars (`--ca-muted`, `--ca-text`, `--ca-accent`,
`--ca-border`) so light/dark and high-contrast themes follow VS Code.

---

## 6. Files touched

| File | Change |
|---|---|
| `webview-ui/src/effort.ts` | **new** — parsing, ladder, sticky preference |
| `webview-ui/src/components/EffortMeter.tsx` | **new** — the row + dot track |
| `webview-ui/src/components/Popover.tsx` | `secondaryFooter` prop |
| `webview-ui/src/components/ModelSelect.tsx` | meter in footer, family grouping, sticky effort on pick |
| `webview-ui/src/components/ModeSelect.tsx` | meter in footer, new props, `←`/`→` keys |
| `webview-ui/src/components/Composer.tsx` | thread `models`/`model`/`onModelChange` to `ModeSelect` |
| `webview-ui/src/sessions/icons.tsx` | `EffortIcon` |
| `webview-ui/src/styles.css` | `.effort-*` rules |
| `test/effort.test.ts` | **new** — see below |
| `README.md` | one line under the composer section |

**Unchanged on purpose:** `src/shared/protocol.ts`, `src/session/TabSession.ts`, `src/extension.ts`,
`src/storage/HistoryStore.ts`, both backends. The feature never leaves the webview; the existing
`tab/setModel` carries it.

---

## 7. Tests (`test/effort.test.ts`, vitest, no DOM)

Seed the real id list from `test/fixtures/invalid-model.stderr.txt` so the tests track the CLI.

1. `parseModelId` round-trips: `claude-opus-5-5-xhigh-fast` → `{family:'claude-opus-5-5', token:'xhigh', fast:true}`.
2. `-thinking` infix preserved: `claude-opus-5-thinking-max` → family `claude-opus-5-thinking`.
3. Legacy order: `claude-4.6-sonnet-medium-thinking` → family `claude-4.6-sonnet`, token `medium`,
   and recomposing at `high` yields `claude-4.6-sonnet-high-thinking` *only if that id exists* —
   it does not, so `modelForEffort` returns `undefined` and the meter shows that family as fixed.
4. `extra-high` beats `high` in longest-match parsing (`gpt-5.5-extra-high`).
5. No-variant ids (`auto`, `composer-2.5`, `gemini-3.1-pro`, `kimi-k2.7-code`) → `token: undefined`.
6. Ladder sparsity: `kimi-k3` (low/high/max) maps Medium→`low`, High→`high`, Max→`max`.
7. `modelForEffort` never returns an id absent from the list.
8. Switching family at Max: picking `claude-sonnet-5-5` with `preferredEffort()==='max'`
   yields `claude-sonnet-5-5-max`.

---

## 8. Open risks

- **Token drift.** Cursor could add tokens (`ultra`?) or rename them. Mitigated by validating every
  composed id against the live list and degrading to "no variants" rather than guessing.
- **`-fast` as a separate family.** `claude-opus-5-5-max` and `claude-opus-5-5-max-fast` are distinct
  models, not an effort pair. Treated as two families; the plan does not add a "fast" toggle. If that
  is wanted later it is a second small meter/switch on the same row.
- **Family labels.** Labels come from the CLI as `<id> - <label>` and the per-variant labels may not
  share a clean prefix. If the mid-effort variant's label still carries the effort word, strip a
  trailing effort word from the label when showing the family row.
