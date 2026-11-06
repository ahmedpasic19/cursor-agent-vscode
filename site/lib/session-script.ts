/**
 * The session that plays out in the rail as you scroll.
 *
 * It is a plausible transcript of this extension doing the thing it is for:
 * one real task, in the shapes the panel actually renders — a user turn with
 * a mode badge and context chips, grouped reads, single tool lines, a diff
 * summary, a checkpoint revert, and a final assistant line.
 */

export type Event =
  | { kind: "user"; mode: "Agent" | "Ask" | "Plan"; text: string }
  | { kind: "tool"; tool: string; arg?: string }
  | { kind: "edit"; tool: string; arg: string; add: number; del: number }
  | { kind: "run" }
  | { kind: "note"; text: string }
  | { kind: "assistant"; text: string };

export const SESSION: Event[] = [
  {
    kind: "user",
    mode: "Agent",
    text: "The composer drops the mode badge when a run finishes. Find out why and fix it.",
  },
  { kind: "tool", tool: "Read", arg: "6 files" },
  { kind: "tool", tool: "Grep", arg: "mode-badge" },
  { kind: "run" },
  {
    kind: "edit",
    tool: "Edit",
    arg: "webview-ui/src/components/Composer.tsx",
    add: 12,
    del: 4,
  },
  { kind: "edit", tool: "Edit", arg: "webview-ui/src/state/store.ts", add: 3, del: 1 },
  { kind: "tool", tool: "Bash", arg: "npm test" },
  { kind: "note", text: "41 passed" },
  {
    kind: "assistant",
    text: "The badge read from the run, not the tab, so it cleared with the run. It reads tab state now.",
  },
];
