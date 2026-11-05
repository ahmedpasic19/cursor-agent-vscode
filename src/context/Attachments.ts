/**
 * Image attachments. The CLI only takes a text prompt, so pasted or dropped images are saved under
 * `<workspace storage>/attachments/<chatId>/` and sent to the agent by path (it opens them with its
 * read tool). The folder is removed with the chat (HistoryStore.delete).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { ContextChip } from '../shared/protocol';
import { chipId } from './chips';

export const IMAGE_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
};
export const IMAGE_EXT: Record<string, string> = Object.fromEntries(
  [...Object.entries(IMAGE_MIME), ['image/jpeg', '.jpeg']].map(([m, e]) => [e, m]),
);
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export type ImageChip = Extract<ContextChip, { kind: 'image' }>;

export function attachmentsDir(workspaceDir: string, chatId: string): string {
  return join(workspaceDir, 'attachments', chatId);
}

/** Saves base64 image bytes for a chat and returns the chip. Same bytes → same file. */
export function saveImage(
  workspaceDir: string,
  chatId: string,
  img: { name: string; mime: string; data: string; thumb?: string },
): ImageChip {
  const ext = IMAGE_MIME[img.mime];
  if (!ext) throw new Error(`Unsupported image type ${img.mime}. Use PNG, JPEG, GIF, WebP or BMP.`);
  const bytes = Buffer.from(img.data, 'base64');
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error(`Image is ${(bytes.length / 1048576).toFixed(1)} MB; the limit is 10 MB.`);
  const dir = attachmentsDir(workspaceDir, chatId);
  mkdirSync(dir, { recursive: true });
  const hash = createHash('sha1').update(bytes).digest('hex').slice(0, 16);
  const file = join(dir, `${hash}${ext}`);
  writeFileSync(file, bytes);
  return { id: chipId(), kind: 'image', name: img.name || `Pasted image${ext}`, absPath: file, mime: img.mime, bytes: bytes.length, thumb: img.thumb };
}

/** Chip for an image already on disk (dragged from the VS Code explorer); not copied. */
export function imageChipForPath(absPath: string, bytes: number): ImageChip | undefined {
  const mime = IMAGE_EXT[extname(absPath).toLowerCase()];
  if (!mime) return undefined;
  return { id: chipId(), kind: 'image', name: absPath.split(/[\\/]/).pop() ?? absPath, absPath, mime, bytes };
}
