/**
 * Webview ↔ host message protocol. Single source of truth (PLAN.md §7).
 * Both sides validate incoming messages with these zod schemas.
 *
 * Phase 1 implements the subset below; later phases extend the unions.
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

export const UserMessageSchema = z.object({
  id: z.string(),
  role: z.literal('user'),
  text: z.string(),
  mode: ModeSchema,
  at: z.number(),
});
export type UserMessage = z.infer<typeof UserMessageSchema>;

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
  transcript: z.array(TranscriptItemSchema),
});
export type TabSnapshot = z.infer<typeof TabSnapshotSchema>;

export const CliStatusSchema = z.object({
  state: z.enum(['checking', 'ready', 'notFound', 'notLoggedIn', 'error']),
  version: z.string().optional(),
  email: z.string().optional(),
  message: z.string().optional(),
});
export type CliStatus = z.infer<typeof CliStatusSchema>;

// ---------- host → webview ----------

export const HostMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('state/full'),
    tabs: z.array(TabSnapshotSchema),
    activeTabId: z.string().optional(),
    cli: CliStatusSchema,
    settings: z.object({ defaultMode: ModeSchema }),
  }),
  z.object({ type: z.literal('tab/updated'), tab: TabSnapshotSchema.omit({ transcript: true }) }),
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
]);
export type HostMessage = z.infer<typeof HostMessageSchema>;

// ---------- webview → host ----------

export const WebviewMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready') }),
  z.object({ type: z.literal('tab/new') }),
  z.object({
    type: z.literal('message/send'),
    tabId: z.string(),
    text: z.string().min(1),
    mode: ModeSchema,
    model: z.string().optional(),
  }),
  z.object({ type: z.literal('run/stop'), tabId: z.string() }),
  z.object({ type: z.literal('file/open'), path: z.string(), line: z.number().optional() }),
  z.object({ type: z.literal('log/show') }),
]);
export type WebviewMessage = z.infer<typeof WebviewMessageSchema>;
