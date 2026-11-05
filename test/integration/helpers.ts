export const results: { name: string; ok: boolean; error?: string }[] = [];

export async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (e) {
    results.push({ name, ok: false, error: String(e instanceof Error ? e.stack : e) });
    console.log(`  ✗ ${name}\n    ${String(e instanceof Error ? e.message : e)}`);
  }
}

export function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, timeoutMs: number, what: string): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${what}`);
}
