/**
 * Session Manager groups, per workspace: <globalStorage>/<workspaceHash>/groups.json.
 * No vscode imports (unit-tested).
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionGroup } from '../shared/protocol';

interface GroupFile {
  version: 1;
  groups: SessionGroup[];
  /** chatId → groupId */
  membership: Record<string, string>;
}

let counter = 0;

export class GroupStore {
  private readonly file: string;
  private data: GroupFile;

  constructor(dir: string, private readonly log?: (l: string) => void) {
    this.file = join(dir, 'groups.json');
    this.data = this.read();
  }

  private read(): GroupFile {
    try {
      const j = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<GroupFile>;
      const groups = Array.isArray(j.groups)
        ? j.groups.filter((g) => g && typeof g.id === 'string' && typeof g.name === 'string').map((g) => ({ id: g.id, name: g.name, collapsed: !!g.collapsed }))
        : [];
      const ids = new Set(groups.map((g) => g.id));
      const membership: Record<string, string> = {};
      for (const [chat, gid] of Object.entries(j.membership ?? {})) if (typeof gid === 'string' && ids.has(gid)) membership[chat] = gid;
      return { version: 1, groups, membership };
    } catch {
      return { version: 1, groups: [], membership: {} };
    }
  }

  private save(): void {
    try {
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data));
      renameSync(tmp, this.file);
    } catch (e) {
      this.log?.(`[groups] save failed: ${String(e)}`);
    }
  }

  get groups(): SessionGroup[] {
    return this.data.groups;
  }

  groupOf(chatId: string): string | undefined {
    return this.data.membership[chatId];
  }

  create(name: string): SessionGroup {
    const g: SessionGroup = { id: `grp_${Date.now().toString(36)}_${(counter++).toString(36)}`, name: name.trim().slice(0, 100) || 'Group', collapsed: false };
    this.data.groups.push(g);
    this.save();
    return g;
  }

  rename(id: string, name: string): void {
    const g = this.data.groups.find((x) => x.id === id);
    if (!g || !name.trim()) return;
    g.name = name.trim().slice(0, 100);
    this.save();
  }

  setCollapsed(id: string, collapsed: boolean): void {
    const g = this.data.groups.find((x) => x.id === id);
    if (!g || g.collapsed === collapsed) return;
    g.collapsed = collapsed;
    this.save();
  }

  /** Deletes the group; its sessions become ungrouped. */
  delete(id: string): void {
    this.data.groups = this.data.groups.filter((g) => g.id !== id);
    for (const [chat, gid] of Object.entries(this.data.membership)) if (gid === id) delete this.data.membership[chat];
    this.save();
  }

  /** Moves a chat into a group, or out of every group when groupId is undefined. */
  move(chatId: string, groupId: string | undefined): void {
    if (groupId && !this.data.groups.some((g) => g.id === groupId)) return;
    if (this.data.membership[chatId] === groupId) return;
    if (groupId) this.data.membership[chatId] = groupId;
    else delete this.data.membership[chatId];
    this.save();
  }

  /** Drop memberships of chats that no longer exist (deleted or pruned). */
  forget(chatIds: Iterable<string>): void {
    let changed = false;
    for (const id of chatIds) {
      if (id in this.data.membership) {
        delete this.data.membership[id];
        changed = true;
      }
    }
    if (changed) this.save();
  }
}
