import { StringDecoder } from 'node:string_decoder';

/**
 * Turns arbitrary stdout chunks into whole lines. Handles multi-byte UTF-8 sequences split across
 * chunks, LF and CRLF, a final line without a newline, and lines longer than `maxLineChars`
 * (cut once, reported as truncated, remainder discarded up to the next newline).
 */
export class LineSplitter {
  private readonly decoder = new StringDecoder('utf8');
  private pending = '';
  private discarding = false;

  constructor(
    private readonly maxLineChars: number,
    private readonly emit: (line: string, truncated: boolean) => void
  ) {}

  push(chunk: Buffer | string): void {
    this.pending += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    let start = 0;
    for (let index = this.pending.indexOf('\n', start); index !== -1; index = this.pending.indexOf('\n', start)) {
      const line = this.pending.slice(start, index).replace(/\r$/, '');
      start = index + 1;
      if (this.discarding) this.discarding = false;
      else this.deliver(line);
    }
    this.pending = this.pending.slice(start);
    if (this.pending.length > this.maxLineChars) {
      if (!this.discarding) this.emit(this.pending.slice(0, this.maxLineChars), true);
      this.discarding = true;
      this.pending = '';
    }
  }

  flush(): void {
    this.pending += this.decoder.end();
    const line = this.pending.replace(/\r$/, '');
    this.pending = '';
    if (!this.discarding && line !== '') this.deliver(line);
    this.discarding = false;
  }

  private deliver(line: string): void {
    if (line.length > this.maxLineChars) this.emit(line.slice(0, this.maxLineChars), true);
    else this.emit(line, false);
  }
}
