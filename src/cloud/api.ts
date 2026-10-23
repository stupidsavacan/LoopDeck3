export interface CloudRevision {
  packId: string;
  revision: number;
  contentFingerprint: string;
  sha256: string;
  size: number;
  title: string;
  questions: number;
  committedAt: string;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid cloud response.');
  return value as Record<string, unknown>;
}
function revision(value: unknown): CloudRevision {
  const r = object(value);
  if (
    typeof r.packId !== 'string' ||
    !r.packId ||
    r.packId.length > 200 ||
    typeof r.title !== 'string' ||
    typeof r.committedAt !== 'string' ||
    !Number.isSafeInteger(r.revision) ||
    Number(r.revision) < 1 ||
    !Number.isSafeInteger(r.size) ||
    Number(r.size) < 0 ||
    Number(r.size) > 32 * 1024 * 1024 ||
    !Number.isSafeInteger(r.questions) ||
    typeof r.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(r.sha256) ||
    typeof r.contentFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(r.contentFingerprint)
  )
    throw new Error('Invalid cloud revision.');
  return r as unknown as CloudRevision;
}
export class CloudHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryAfter = 0
  ) {
    super(`HTTP ${status}: ${code}`);
  }
}
export class CloudApi {
  constructor(
    readonly base: string,
    private readonly token?: string,
    private readonly transport: typeof fetch = fetch
  ) {
    const url = new URL(base);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/')
      throw new Error('APIにはHTTPSのオリジンだけを指定してください。');
  }
  async request(path: string, options: RequestInit = {}): Promise<Response> {
    const headers = new Headers(options.headers);
    if (this.token) headers.set('Authorization', `Bearer ${this.token}`);
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), 60000);
    try {
      const response = await this.transport.call(globalThis, this.base.replace(/\/$/, '') + '/api/v1' + path, {
        ...options,
        headers,
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        signal: controller.signal
      });
      if (!response.ok) {
        const raw = await response.json().catch(() => ({ error: 'request_failed' }));
        const body = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
        const retry = response.headers.get('retry-after');
        const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : Math.max(0, (Date.parse(retry ?? '') - Date.now()) / 1000);
        throw new CloudHttpError(
          response.status,
          typeof body.error === 'string' ? body.error : 'request_failed',
          Number.isFinite(seconds) ? seconds * 1000 : 0
        );
      }
      return response;
    } finally {
      clearTimeout(timer);
    }
  }
  async login(passphrase: string, deviceName: string): Promise<string> {
    const r = await this.request('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passphrase, deviceName })
    });
    const body = object(await r.json());
    if (typeof body.token !== 'string' || !/^[a-f0-9]{64}$/.test(body.token)) throw new Error('Invalid cloud session.');
    return body.token;
  }
  async heads(): Promise<CloudRevision[]> {
    // A changed library sequence invalidates the whole paginated snapshot.
    for (let attempt = 0; attempt < 3; attempt++) {
      const rows: CloudRevision[] = [];
      let cursor: string | null = null,
        sequence: number | undefined,
        changed = false;
      const seen = new Set<string>();
      do {
        const response = await this.request('/packs' + (cursor ? '?after=' + encodeURIComponent(cursor) : ''));
        const page = object(await response.json());
        if (
          !Array.isArray(page.packs) ||
          !Number.isSafeInteger(page.sequence) ||
          (page.nextCursor !== null && typeof page.nextCursor !== 'string')
        )
          throw new Error('Invalid cloud page.');
        if (sequence !== undefined && sequence !== page.sequence) {
          changed = true;
          break;
        }
        sequence = page.sequence as number;
        rows.push(...page.packs.map(revision));
        cursor = page.nextCursor as string | null;
        if (cursor) {
          if (seen.has(cursor)) throw new Error('クラウド一覧のカーソルが循環しています。');
          seen.add(cursor);
        }
      } while (cursor);
      if (!changed) return rows;
    }
    throw new Error('クラウド一覧が更新中です。次回自動再試行します。');
  }
  async upload(packId: string, opId: string, blob: Blob, fp: string, onlyIfAbsent = false): Promise<CloudRevision> {
    return revision(
      await (
        await this.request(`/packs/${encodeURIComponent(packId)}/revisions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/zip',
            'Idempotency-Key': opId,
            'X-Content-Fingerprint': fp,
            ...(onlyIfAbsent ? { 'If-None-Match': '*' } : {})
          },
          body: blob
        })
      ).json()
    );
  }
  async download(head: CloudRevision): Promise<ArrayBuffer> {
    const response = await this.request(`/packs/${encodeURIComponent(head.packId)}/revisions/${head.revision}/download`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Empty cloud ZIP.');
    const bytes = new Uint8Array(head.size);
    let offset = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        void reader.cancel();
        reject(new Error('Cloud download timed out.'));
      }, 60000);
    });
    try {
      for (;;) {
        const { value, done } = await Promise.race([reader.read(), timeout]);
        if (done) break;
        if (offset + value.length > bytes.length) {
          await reader.cancel();
          throw new Error('Cloud ZIP too large.');
        }
        bytes.set(value, offset);
        offset += value.length;
      }
      if (offset !== bytes.length) throw new Error('Cloud ZIP truncated.');
      return bytes.buffer;
    } finally {
      clearTimeout(timer);
    }
  }
  async history(packId: string): Promise<CloudRevision[]> {
    const body = object(await (await this.request(`/packs/${encodeURIComponent(packId)}/revisions`)).json());
    if (!Array.isArray(body.revisions)) throw new Error('Invalid cloud history.');
    return body.revisions.map(revision);
  }
  async restore(packId: string, targetRevision: number, opId: string): Promise<CloudRevision> {
    return revision(
      await (
        await this.request(`/packs/${encodeURIComponent(packId)}/restore`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': opId },
          body: JSON.stringify({ revision: targetRevision })
        })
      ).json()
    );
  }
}
