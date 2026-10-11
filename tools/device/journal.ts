import { appendFileSync } from 'node:fs';

export type JournalSource = 'runner' | 'step' | 'check' | 'js' | 'diag' | 'screen' | 'logcat' | 'shell';

export interface JournalRecord {
  seq: number;
  tHost: number;
  src: JournalSource;
  type: string;
  stepId: string | null;
  data: unknown;
}

/** Append-only NDJSON event log for one run. Holds raw event bodies; it never leaves LDEV_HOME. */
export class Journal {
  private seq = 0;

  constructor(
    private readonly path: string,
    private readonly now: () => number
  ) {}

  append(src: JournalSource, type: string, data: unknown, stepId?: string): number {
    const record: JournalRecord = { seq: ++this.seq, tHost: this.now(), src, type, stepId: stepId ?? null, data };
    appendFileSync(this.path, `${JSON.stringify(record)}\n`);
    return record.seq;
  }
}
