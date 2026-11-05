/**
 * Webview ↔ host message protocol. Single source of truth (PLAN.md §7).
 * Both sides validate incoming messages with these zod schemas.
 *
 * Later phases extend the unions.
 */
import { z } from 'zod';
import type { AgentEvent, RunOutcome } from './events';

export const ModeSchema = z.enum(['agent', 'ask', 'plan']);

const agentEvent = z.custom<AgentEvent>(
  (v) => typeof v === 'object' && v !== null && typeof (v as { kind?: unknown }).kind === 'string',
);
const runOutcome = z.custom<RunOutcome>(
  (v) => typeof v === 'object' && v !== null && typeof (v as { status?: unknown }).status === 'string',
);

// ---------- shared data shapes ----------

/** Add-to-Chat context (PLAN.md §5.4). Paths are workspace-relative with forward slashes. */
export const ContextChipSchema = z.discriminatedUnion('kind', [
  z.object({
    id: z.string(),
    kind: z.literal('selection'),
    path: z.string(),
    absPath: z.string(),
    startLine: z.number(),
    endLine: z.number(),
    language: z.string().optional(),
    /** Snapshot of the full lines startLine..endLine; absent when over the size limit. */
    text: z.string().optional(),
    /** The file changed after the snapshot was taken (the snapshot is still what gets sent). */
    changed: z.boolean().optional(),
  }),
  z.object({ id: z.string(), kind: z.literal('file'), path: z.string(), absPath: z.string(), isFolder: z.boolean() }),
  z.object({ id: z.string(), kind: z.literal('terminal'), name: z.string(), text: z.string(), lineCount: z.number() }),
  z.object({
    id: z.string(),
    kind: z.literal('diagnostics'),
    /** Undefined = whole workspace. */
    path: z.string().optional(),
    items: z.array(z.object({ path: z.string(), line: z.string() })),
  }),
]);
export type ContextChip = z.infer<typeof ContextChipSchema>;

export const UserMessageSchema = z.object({
  id: z.string(),
  role: z.literal('user'),
  text: z.string(),
  mode: ModeSchema,
  at: z.number(),
  /** Chips attached to this message (snapshotted at send time). */
  chips: z.array(ContextChipSchema).optional(),
});
export type UserMessage = z.infer<typeof UserMessageSchema>;

/** One file changed by an Agent run (from the shadow-git pre/post diff). */
export const ChangedFileSchema = z.object({
  path: z.string(),
  status: z.enum(['A', 'M', 'D']),
  added: z.number(),
  removed: z.number(),
  binary: z.boolean(),
  state: z.enum(['pending', 'kept', 'reverted']),
  /** Also edited by another tab's Agent run that overlapped this one; skipped by Revert all. */
  foreign: z.boolean().optional(),
});
export type ChangedFile = z.infer<typeof ChangedFileSchema>;

export const RunChangesSchema = z.object({
  /** pending: run in progress; ready: diff computed; unavailable: no checkpoint (message says why). */
  status: z.enum(['pending', 'ready', 'unavailable']),
  preSha: z.string().optional(),
  postSha: z.string().optional(),
  files: z.array(ChangedFileSchema),
  message: z.string().optional(),
});
export type RunChanges = z.infer<typeof RunChangesSchema>;

export const RunRecordSchema = z.object({
  id: z.string(),
  role: z.literal('run'),
  mode: ModeSchema,
  model: z.string().optional(),
  status: z.enum(['queued', 'running', 'success', 'error', 'stopped', 'timeout', 'interrupted']),
  events: z.array(agentEvent),
  outcome: runOutcome.optional(),
  startedAt: z.number(),
  endedAt: z.number().optional(),
  /** Agent runs only: checkpoint and changed files. */
  changes: RunChangesSchema.optional(),
  /** Non-blocking warnings, e.g. another tab editing the same workspace at the same time. */
  warnings: z.array(z.string()).optional(),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;

export const TranscriptItemSchema = z.union([UserMessageSchema, RunRecordSchema]);
export type TranscriptItem = z.infer<typeof TranscriptItemSchema>;

export const TabSnapshotSchema = z.object({
  id: z.string(),
  title: z.string(),
  sessionId: z.string().optional(),
  mode: ModeSchema,
  model: z.string().optional(),
  cwd: z.string().optional(),
  running: z.boolean(),
  /** Runs use `-w <name>` (an isolated git worktree under ~/.cursor/worktrees). */
  worktree: z.boolean().optional(),
  /** Worktree path reported by the CLI, once known. */
  worktreePath: z.string().optional(),
  /** Chips waiting in the composer for the next message. */
  chips: z.array(ContextChipSchema),
  transcript: z.array(TranscriptItemSchema),
});
export type TabSnapshot = z.infer<typeof TabSnapshotSchema>;

export const CliStatusSchema = z.object({
  state: z.enum(['checking', 'ready', 'notFound', 'notLoggedIn', 'error']),
  version: z.string().optional(),
  email: z.string().optional(),
  message: z.string().optional(),
  /** CLI features detected from --help; a missing feature disables its UI. */
  features: z
    .object({ modes: z.boolean(), partialOutput: z.boolean(), worktree: z.boolean() })
    .optional(),
});
export type CliStatus = z.infer<typeof CliStatusSchema>;

export const ModelOptionSchema = z.object({ id: z.string(), label: z.string(), isDefault: z.boolean().optional() });
export type ModelOption = z.infer<typeof ModelOptionSchema>;

export const HistoryItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  messageCount: z.number(),
  /** First user message, for search and preview. */
  preview: z.string(),
  open: z.boolean(),
});
export type HistoryItem = z.infer<typeof HistoryItemSchema>;

export const MentionItemSchema = z.object({ path: z.string(), isFolder: z.boolean() });
export type MentionItem = z.infer<typeof MentionItemSchema>;

// ---------- host → webview ----------

export const HostMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('state/full'),
    tabs: z.array(TabSnapshotSchema),
    activeTabId: z.string().optional(),
    cli: CliStatusSchema,
    settings: z.object({ defaultMode: ModeSchema }),
  }),
  z.object({ type: z.literal('tab/updated'), tab: TabSnapshotSchema.omit({ transcript: true, chips: true }) }),
  z.object({ type: z.literal('tab/reset'), tab: TabSnapshotSchema }),
  z.object({ type: z.literal('tab/created'), tab: TabSnapshotSchema }),
  z.object({ type: z.literal('tab/closed'), tabId: z.string() }),
  z.object({ type: z.literal('tab/activated'), tabId: z.string() }),
  z.object({ type: z.literal('run/warnings'), tabId: z.string(), runId: z.string(), warnings: z.array(z.string()) }),
  z.object({ type: z.literal('history/list'), items: z.array(HistoryItemSchema) }),
  z.object({ type: z.literal('history/show') }),
  z.object({ type: z.literal('chips/updated'), tabId: z.string(), chips: z.array(ContextChipSchema) }),
  z.object({ type: z.literal('mention/results'), requestId: z.number(), items: z.array(MentionItemSchema) }),
  z.object({ type: z.literal('models/list'), models: z.array(ModelOptionSchema), source: z.enum(['cli', 'setting']) }),
  /** Transient message shown in the panel (e.g. "chip over the size limit"). */
  z.object({ type: z.literal('notice'), level: z.enum(['info', 'warning', 'error']), text: z.string() }),
  z.object({ type: z.literal('cli/status'), cli: CliStatusSchema }),
  z.object({ type: z.literal('run/started'), tabId: z.string(), user: UserMessageSchema, run: RunRecordSchema }),
  z.object({ type: z.literal('run/event'), tabId: z.string(), runId: z.string(), event: agentEvent }),
  z.object({
    type: z.literal('run/finished'),
    tabId: z.string(),
    runId: z.string(),
    status: RunRecordSchema.shape.status,
    outcome: runOutcome,
  }),
  z.object({ type: z.literal('composer/focus') }),
  z.object({ type: z.literal('changes/updated'), tabId: z.string(), runId: z.string(), changes: RunChangesSchema }),
]);
export type HostMessage = z.infer<typeof HostMessageSchema>;

// ---------- webview → host ----------

export const WebviewMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready') }),
  z.object({ type: z.literal('tab/new') }),
  z.object({ type: z.literal('tab/close'), tabId: z.string() }),
  z.object({ type: z.literal('tab/activate'), tabId: z.string() }),
  z.object({ type: z.literal('tab/rename'), tabId: z.string(), title: z.string().min(1).max(200) }),
  z.object({ type: z.literal('history/request') }),
  z.object({ type: z.literal('history/open'), id: z.string() }),
  z.object({ type: z.literal('history/delete'), id: z.string() }),
  /** Resume an interrupted run: send "continue" with --resume. */
  z.object({ type: z.literal('run/resume'), tabId: z.string() }),
  z.object({
    type: z.literal('message/send'),
    tabId: z.string(),
    text: z.string().min(1),
    mode: ModeSchema,
    model: z.string().optional(),
    /** Chips to attach (must belong to the tab); they are consumed. */
    chipIds: z.array(z.string()).default([]),
  }),
  z.object({ type: z.literal('chip/remove'), tabId: z.string(), chipId: z.string() }),
  z.object({ type: z.literal('mention/search'), tabId: z.string(), query: z.string(), requestId: z.number() }),
  z.object({ type: z.literal('mention/pick'), tabId: z.string(), path: z.string(), isFolder: z.boolean() }),
  /** /clear: start a new CLI session in the same tab. */
  z.object({ type: z.literal('tab/clear'), tabId: z.string() }),
  z.object({ type: z.literal('tab/setModel'), tabId: z.string(), model: z.string().optional() }),
  z.object({ type: z.literal('models/refresh') }),
  z.object({ type: z.literal('changes/openDiff'), tabId: z.string(), runId: z.string(), path: z.string() }),
  z.object({ type: z.literal('changes/revertFile'), tabId: z.string(), runId: z.string(), path: z.string() }),
  z.object({ type: z.literal('changes/keepFile'), tabId: z.string(), runId: z.string(), path: z.string() }),
  z.object({ type: z.literal('changes/revertAll'), tabId: z.string(), runId: z.string() }),
  z.object({ type: z.literal('changes/keepAll'), tabId: z.string(), runId: z.string() }),
  /** Restore the files changed by this message's run and every later run to before this message. */
  z.object({ type: z.literal('checkpoint/restore'), tabId: z.string(), userMessageId: z.string() }),
  z.object({ type: z.literal('run/stop'), tabId: z.string() }),
  /** Resend the last user message of the tab with the same mode. */
  z.object({ type: z.literal('run/retry'), tabId: z.string() }),
  /** "Run this plan": resume the session in Agent mode and implement the plan. */
  z.object({ type: z.literal('plan/execute'), tabId: z.string() }),
  z.object({
    type: z.literal('file/open'),
    path: z.string(),
    line: z.number().optional(),
    endLine: z.number().optional(),
  }),
  /** Diff a tool's pre-edit content (from the edit event) against the file on disk. */
  z.object({ type: z.literal('tool/openDiff'), path: z.string(), before: z.string().optional() }),
  z.object({ type: z.literal('auth/login') }),
  z.object({ type: z.literal('cli/refresh') }),
  z.object({ type: z.literal('settings/open'), query: z.string().optional() }),
  z.object({ type: z.literal('log/show') }),
  z.object({ type: z.literal('code/copy'), code: z.string() }),
  z.object({ type: z.literal('code/insert'), code: z.string() }),
  z.object({ type: z.literal('code/apply'), tabId: z.string(), path: z.string().min(1), code: z.string() }),
  /** Per-tab "run in a git worktree" toggle (CLI -w). */
  z.object({ type: z.literal('tab/setWorktree'), tabId: z.string(), enabled: z.boolean() }),
  z.object({ type: z.literal('worktree/open'), path: z.string() }),
]);
export type WebviewMessage = z.infer<typeof WebviewMessageSchema>;
