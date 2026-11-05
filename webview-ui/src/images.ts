/** Image attachment helpers for the composer: paste, drop and file picker. */
import { send } from './vscode';

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp'];
const MAX_BYTES = 10 * 1024 * 1024;
const THUMB = 96;

export function imageFiles(list: FileList | File[] | null | undefined): File[] {
  return [...(list ?? [])].filter((f) => IMAGE_TYPES.includes(f.type));
}

function readDataUrl(f: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });
}

/** Small WebP thumbnail (falls back to no thumbnail if the browser can't decode it). */
async function thumbnail(f: File): Promise<string | undefined> {
  try {
    const bmp = await createImageBitmap(f);
    const scale = Math.min(1, THUMB / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * scale));
    c.height = Math.max(1, Math.round(bmp.height * scale));
    c.getContext('2d')?.drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close();
    return c.toDataURL('image/webp', 0.8);
  } catch {
    return undefined;
  }
}

/** Sends each image to the host, which saves it and adds a chip. Returns an error text, if any. */
export async function attachImages(tabId: string, files: File[]): Promise<string | undefined> {
  let error: string | undefined;
  for (const f of files) {
    if (f.size > MAX_BYTES) {
      error = `${f.name || 'Image'} is ${(f.size / 1048576).toFixed(1)} MB; the limit is 10 MB.`;
      continue;
    }
    const [url, thumb] = await Promise.all([readDataUrl(f), thumbnail(f)]);
    const data = url.slice(url.indexOf(',') + 1);
    const name = f.name && f.name !== 'image.png' ? f.name : `Pasted image ${new Date().toLocaleTimeString()}`;
    send({ type: 'image/add', tabId, name, mime: f.type, data, thumb });
  }
  return error;
}

/** file:// image URIs from a VS Code explorer drag (`text/uri-list`). */
export function imageUris(dt: DataTransfer): string[] {
  const raw = dt.getData('text/uri-list') || dt.getData('application/vnd.code.uri-list');
  if (!raw) return [];
  let list: string[];
  try {
    list = raw.trim().startsWith('[') ? (JSON.parse(raw) as string[]) : raw.split(/\r?\n/);
  } catch {
    list = raw.split(/\r?\n/);
  }
  return list.map((s) => s.trim()).filter((s) => s.startsWith('file:') && /\.(png|jpe?g|gif|webp|bmp)$/i.test(s));
}
