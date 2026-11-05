import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const FIXTURES = resolve(import.meta.dirname, 'fixtures');

export interface Fixture {
  name: string;
  lines: string[];
  meta: { args: string[]; exitCode: number | null; [k: string]: unknown };
  partial: boolean;
}

export function loadFixtures(): Fixture[] {
  return readdirSync(FIXTURES)
    .filter((f) => f.endsWith('.meta.json'))
    .map((f) => {
      const name = f.slice(0, -'.meta.json'.length);
      const meta = JSON.parse(readFileSync(join(FIXTURES, f), 'utf8'));
      const lines = readFileSync(join(FIXTURES, `${name}.ndjson`), 'utf8').split('\n');
      return { name, lines, meta, partial: meta.args.includes('--stream-partial-output') };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
