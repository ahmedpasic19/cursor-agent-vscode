import { StringDecoder } from 'node:string_decoder';

/**
 * Splits a byte stream into lines. Safe across chunk boundaries, including
 * boundaries inside a multi-byte UTF-8 character. Strips trailing `\r`.
 */
export class LineReader {
  private readonly decoder = new StringDecoder('utf8');
  private buf = '';

  constructor(private readonly onLine: (line: string) => void) {}

  push(chunk: Buffer | string): void {
    this.buf += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).replace(/\r$/, '');
      this.buf = this.buf.slice(nl + 1);
      this.onLine(line);
    }
  }

  /** Flush any trailing partial line (call on stream end). */
  end(): void {
    this.buf += this.decoder.end();
    if (this.buf.length) {
      const line = this.buf.replace(/\r$/, '');
      this.buf = '';
      this.onLine(line);
    }
  }
}

/** Fixed-size ring buffer of lines (used for the stderr tail). */
export class RingBuffer {
  private readonly items: string[] = [];
  constructor(private readonly size: number) {}
  push(line: string): void {
    this.items.push(line);
    if (this.items.length > this.size) this.items.shift();
  }
  toArray(): string[] {
    return [...this.items];
  }
}
