# Skills and custom commands in the `/` menu

**Problem.** Typing `/` in the composer only offers the six hard-coded UI commands
(`src/shared/../../webview-ui/src/components/Composer.tsx` → `SLASH`). The user's skills
(`~/.cursor/skills/frontend-design`, …) and custom commands are invisible, while Claude Code lists
them in the same popup. Some skills are *only* reachable this way: `~/.cursor/skills-cursor/review/SKILL.md`
carries `disable-model-invocation: true`, so the model will never pick it up on its own.

**Goal.** `/` lists built-in commands **plus** discovered skills and custom commands, filtered as you
type, and picking one puts a working invocation into the prompt.

---

## 1. What exists on disk (verified against cursor-agent 2026.11.05-86047df)

The CLI bundle holds this source list (`index.js`, lightly reformatted):

```js
[['.cursor','skills'], ['.cursor','skills-cursor'], ['.claude','skills'], ['.claude','plugins'],
 ['.codex','skills'], ['.grok','skills'], ['.agents','skills'], ['.cursor','plugins']]
```

each resolved **both** under `$HOME` and under the workspace root. Confirmed locally:

| Location | Holds | Notes |
| --- | --- | --- |
| `~/.cursor/skills/<name>/SKILL.md` | user skills | `frontend-design`, `interview`, … |
| `~/.cursor/skills-cursor/<name>/SKILL.md` | Cursor built-ins | `review`, `loop`, `share`, … (~22) |
| `~/.cursor/commands/*.md` | user slash commands | empty here, but the CLI reads it |
| `~/.cursor/plugins/cache/<marketplace>/<plugin>/<ref>/skills/<name>/SKILL.md` | plugin skills | e.g. `supabase`, `vercel` |
| `~/.cursor/plugins/local/` | locally added plugin dirs | same layout |
| `<workspace>/.cursor/{skills,commands}`, `<workspace>/.claude/{skills,commands}` | project-scoped | this repo has `.claude/` |

`SKILL.md` front matter: `name`, `description`, optional `disable-model-invocation`.
A command `.md` is a prompt body, optionally with its own `description` front matter and
`$ARGUMENTS` / `$1`-style placeholders.

---

## 2. Open question to settle before coding (one spike, ~10 min)

Does `cursor-agent -p "/frontend-design make the hero bolder"` expand the slash command, or does it
reach the model as literal text? The CLI's `--help` has no skills/commands subcommand, and the
protobuf message in the bundle carries `slashCommand` + `promptBody` as *separate* fields — which
suggests the TUI parses the slash itself and the raw `-p` string does **not** get that treatment.

Run both of these against a trivial skill and keep the ndjson as a fixture (like
`test/fixtures/*.meta.json`). *Optional recorded fixture:* add `test/fixtures/slash-spike.{meta.json,ndjson}` after you run the CLI locally.

1. `-p "/review"` → does the run behave like the skill, or does the model answer "I don't have a /review command"?
2. `-p "Use the \"review\" skill."` → baseline.

**Plan assumes the pessimistic answer** (no server-side expansion) and expands on our side, which
works either way. If the spike shows the CLI does expand, drop §5's skill-expansion and pass through.

---

## 3. Host: discovery (`src/context/SkillIndex.ts`, new)

```ts
export interface AgentCommand {
  /** Invocation name, e.g. "frontend-design" or "supabase:migrate". */
  name: string;
  kind: 'skill' | 'command';
  description?: string;
  /** Absolute path to SKILL.md / the command .md. */
  file: string;
  /** "User", "Cursor", "Project", or the plugin name — shown on the right of the row. */
  source: string;
  /** Skills only: front matter `disable-model-invocation: true`. */
  userOnly?: boolean;
}
```

- `scan(roots: string[]): Promise<AgentCommand[]>` walks the table in §1 — `$HOME` first, then each
  workspace folder — plus any `cursorAgent.skills.extraDirs`.
- Front matter parsing: hand-rolled, not a yaml dependency. Read the first ~4 KB of each file, take
  the block between the leading `---` lines, pull `name` / `description` / `disable-model-invocation`.
  Fall back to the folder name when `name` is absent; skip files whose front matter won't parse.
- Name collisions: the first scan order wins (project > user > plugin > Cursor built-in), later ones
  get a `source` suffix in the UI only; plugin skills are named `<plugin>:<skill>`.
- Caching + invalidation, mirroring `FileIndex`: cache the result, drop it on a
  `vscode.FileSystemWatcher` over `**/.cursor/{skills,commands}/**` and `**/.claude/{skills,commands}/**`
  in the workspace, and on a 60 s TTL for the `$HOME` dirs (no watcher outside the workspace).
- Cap at ~300 entries and log how long the scan took (`[skills] scanned N in Xms`) — the plugin cache
  can be large.

## 4. Protocol + wiring

`src/shared/protocol.ts`:

- `AgentCommandSchema` for the shape above.
- host → webview: `{ type: 'commands/list', commands: AgentCommand[] }`.
- webview → host: `{ type: 'commands/refresh' }`.

Push is simpler than the request/response dance `mention/search` uses: the list is small and static
between file changes.

`src/extension.ts`:

- Construct `SkillIndex` next to `fileIndex` (line ~59).
- Send the list from `sendFullState()` (alongside `sendModels()`), on the watcher firing, and on
  `commands/refresh`.
- Handle `commands/refresh` in `handle()`.

`webview-ui/src/state/store.ts`: `commands: AgentCommand[]` in state, set from `commands/list`
(next to the `models/list` case at line 212).

## 5. Sending: expansion (`src/session/promptBuilder.ts`)

The transcript should keep showing what the user typed (`/review the auth diff`), so expansion
happens on the host at prompt-build time, not in the composer.

- `PromptInput` gains `command?: { kind, name, file, body?, args?: string }`.
- `SessionManager.send` matches a leading `/<name>` against the `SkillIndex` and attaches it.
- **command (`.md` prompt file):** substitute `$ARGUMENTS` (and `$1`…`$9`) in the body, and use the
  result as the message text. If the body has no placeholder, append the args as a final line.
- **skill:** prepend one line and keep the user's text:
  `Use the "<name>" skill (<abs path to SKILL.md>) for this request.` Reading the file is a normal
  Read tool call for the agent, so this works on both backends with no CLI support needed.
- Unknown `/word` that matches nothing: send verbatim, as today.
- SDK backend needs nothing extra — it goes through the same `buildPrompt`.

## 6. Webview: the popup (`webview-ui/src/components/Composer.tsx`)

- **Fix the trigger regexes first — they are why `/frontend-design` can't even be typed today.**
  `detectPopup` uses `/^\/(\w*)$/` and `runSlash` uses `/^\/(\w+)(?:\s+(.*))?$/`; `\w` excludes `-`
  and `:`, so the popup closes at the first hyphen. Use `[\w:-]` in both.
- `SLASH` (the six built-ins) merges with `useStore(s => s.commands)` into one list.
- Filtering: `startsWith` on the name first, then a substring/fuzzy pass over name **and**
  description, so `/design` finds `frontend-design`. Cap the popup at ~12 rows.
- Grouping, matching the screenshot: section headers `Slash Commands`, `Skills`, `Commands`, with the
  built-ins first. `active`/ArrowUp/ArrowDown index over the flattened list — keep one flat
  `options` array and render headers from it, so the existing keyboard code is untouched.
- Row: `OptionRow` with `label={/name}`, `description={description}` (truncated to one line, it is
  long in `SKILL.md`), `trailing={source}`.
- `pickSlash` for a discovered entry: insert `/<name> ` and leave the caret at the end (never
  auto-run — skills take a request). Built-ins keep today's behaviour.
- `runSlash` keeps its `switch` and still returns `false` for an unknown name, so `submit()` sends
  it as a message and §5 expands it.
- Empty state: `No matching command or skill.`

## 7. Settings, docs, tests

- `package.json`: `cursorAgent.skills.enabled` (default `true`) and
  `cursorAgent.skills.extraDirs: string[]` (default `[]`).
- `webview-ui/src/components/HelpPanel.tsx:11` — mention skills in the `/` row.
- `PLAN.md` §"`/` commands" and `README.md`: note that skills and custom commands are listed.
- Tests (vitest, `test/skills.test.ts`):
  - front-matter parsing: well-formed, missing `description`, no front matter, `disable-model-invocation`;
  - discovery over a temp dir tree covering user / project / plugin layouts, including collisions;
  - `buildPrompt` with a skill command and with a `.md` command body (`$ARGUMENTS` present and absent);
  - composer filtering is a pure function — extract `filterCommands(query, list)` and unit-test it,
    including the hyphen case that is broken today.

## 8. Order of work

1. Spike §2 and record the fixture.
2. `SkillIndex` + parser + tests (host only, no UI).
3. Protocol, extension wiring, store.
4. Composer: regex fix, merged list, grouped rendering.
5. `promptBuilder` expansion + `SessionManager` hook.
6. Settings, help text, docs.

Steps 2–4 alone already fix the visible complaint; step 5 is what makes a picked skill actually run.
