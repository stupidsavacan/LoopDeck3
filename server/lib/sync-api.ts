import { contentFingerprint, sha256, importLoopDeckZip } from '../generated/pack-protocol.mjs';

export interface SyncEnv {
  DB?: D1Database;
  BUCKET?: R2Bucket;
  SYNC_PASSPHRASE?: string;
  ALLOWED_ORIGINS?: string;
  ALLOW_NULL_ORIGIN?: string;
}
export const MAX_ZIP = 32 * 1024 * 1024;
const enc = new TextEncoder();
class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string
  ) {
    super(code);
  }
}
const fail = (status: number, code: string): never => {
  throw new HttpError(status, code);
};
type Row = {
  pack_id: string;
  revision: number;
  fingerprint: string;
  sha256: string;
  size: number;
  object_key: string;
  title: string;
  questions: number;
  committed_at: string;
};
const metadata = (r: Row) => ({
  packId: r.pack_id,
  revision: r.revision,
  contentFingerprint: r.fingerprint,
  sha256: r.sha256,
  size: r.size,
  title: r.title,
  questions: r.questions,
  committedAt: r.committed_at
});
const columns = 'r.pack_id,r.revision,r.fingerprint,r.sha256,r.size,r.object_key,r.title,r.questions,r.committed_at';
const pending = 'EXISTS(SELECT 1 FROM cloud_receipts WHERE op_id=? AND request_fp=? AND result IS NULL)';

async function readSmallJson(request: Request) {
  const buffer = await readBounded(request, 4096);
  try {
    return JSON.parse(new TextDecoder().decode(buffer));
  } catch {
    return fail(400, 'invalid_json');
  }
}
async function readBounded(request: Request, max: number): Promise<ArrayBuffer> {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > max))
    fail(Number(declared) > max ? 413 : 400, 'invalid_body_size');
  if (!request.body) fail(400, 'empty_body');
  // One allocation, no chunk-array + concatenated-buffer duplication. Views are not copied.
  const bytes = new Uint8Array(declared === null ? max : Number(declared));
  let offset = 0;
  const reader = request.body!.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (offset + value.length > max || offset + value.length > bytes.length) {
      await reader.cancel();
      fail(413, 'body_too_large');
    }
    bytes.set(value, offset);
    offset += value.length;
  }
  if (declared !== null && offset !== Number(declared)) fail(400, 'body_size_mismatch');
  return offset === bytes.length ? bytes.buffer : bytes.buffer.slice(0, offset);
}
async function init(db: D1Database, secret: string) {
  const stamp = await sha256(enc.encode('loopdeck-session-generation:' + secret).buffer);
  await db.prepare("INSERT OR IGNORE INTO cloud_library(id,secret_stamp,epoch,seq) VALUES(1,'',0,0)").run();
  await db.prepare('UPDATE cloud_library SET secret_stamp=?,epoch=epoch+1 WHERE id=1 AND secret_stamp<>?').bind(stamp, stamp).run();
  return (await db.prepare('SELECT epoch,seq FROM cloud_library WHERE id=1').first<{ epoch: number; seq: number }>())!;
}
async function rate(db: D1Database, key: string, max: number, seconds: number) {
  const now = Math.floor(Date.now() / 1000),
    reset = (Math.floor(now / seconds) + 1) * seconds;
  const row = await db
    .prepare(
      'INSERT INTO cloud_limits(key,count,reset_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN reset_at<=? THEN 1 ELSE count+1 END,reset_at=CASE WHEN reset_at<=? THEN excluded.reset_at ELSE reset_at END RETURNING count,reset_at'
    )
    .bind(key, reset, now, now)
    .first<{ count: number; reset_at: number }>();
  if (!row || row.count > max)
    throw Object.assign(new HttpError(429, 'rate_limited'), { retryAfter: Math.max(1, (row?.reset_at ?? reset) - now) });
}
async function receipt(db: D1Database, op: string, requestFp: string) {
  const r = await db
    .prepare('SELECT request_fp,result FROM cloud_receipts WHERE op_id=?')
    .bind(op)
    .first<{ request_fp: string; result: string | null }>();
  if (r && r.request_fp !== requestFp) fail(409, 'idempotency_key_reused');
  return r?.result ? JSON.parse(r.result) : undefined;
}
async function commit(
  db: D1Database,
  op: string,
  requestFp: string,
  row: Omit<Row, 'revision' | 'committed_at'>,
  force: boolean,
  onlyIfAbsent = false
) {
  const check =
    pending +
    ' AND (?=1 OR NOT EXISTS(SELECT 1 FROM cloud_heads h JOIN cloud_revisions r ON r.pack_id=h.pack_id AND r.revision=h.revision WHERE h.pack_id=? AND r.fingerprint=?))';
  const args = [op, requestFp, force ? 1 : 0, row.pack_id, row.fingerprint];
  await db.batch([
    db
      .prepare(
        'INSERT OR IGNORE INTO cloud_receipts(op_id,request_fp,result) SELECT ?,?,NULL WHERE ?=0 OR NOT EXISTS(SELECT 1 FROM cloud_heads WHERE pack_id=?)'
      )
      .bind(op, requestFp, onlyIfAbsent ? 1 : 0, row.pack_id),
    db.prepare('UPDATE cloud_library SET seq=seq+1 WHERE id=1 AND ' + check).bind(...args),
    db
      .prepare(
        "INSERT INTO cloud_revisions(pack_id,revision,fingerprint,sha256,size,object_key,title,questions,committed_at,op_id) SELECT ?,seq,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),? FROM cloud_library WHERE id=1 AND " +
          check
      )
      .bind(row.pack_id, row.fingerprint, row.sha256, row.size, row.object_key, row.title, row.questions, op, ...args),
    db
      .prepare(
        'INSERT INTO cloud_heads(pack_id,revision) SELECT pack_id,revision FROM cloud_revisions WHERE op_id=? AND ' +
          pending +
          ' ON CONFLICT(pack_id) DO UPDATE SET revision=excluded.revision WHERE excluded.revision>cloud_heads.revision'
      )
      .bind(op, op, requestFp),
    db
      .prepare(
        "UPDATE cloud_receipts SET result=(SELECT json_object('packId',r.pack_id,'revision',r.revision,'contentFingerprint',r.fingerprint,'sha256',r.sha256,'size',r.size,'title',r.title,'questions',r.questions,'committedAt',r.committed_at) FROM cloud_heads h JOIN cloud_revisions r ON h.pack_id=r.pack_id AND h.revision=r.revision WHERE h.pack_id=?) WHERE op_id=? AND request_fp=? AND result IS NULL"
      )
      .bind(row.pack_id, op, requestFp),
    db
      .prepare(
        'INSERT OR IGNORE INTO cloud_garbage(object_key,attempts,next_attempt) SELECT object_key,0,0 FROM cloud_revisions WHERE pack_id=? AND revision NOT IN(SELECT revision FROM cloud_revisions WHERE pack_id=? ORDER BY revision DESC LIMIT 10)'
      )
      .bind(row.pack_id, row.pack_id),
    db
      .prepare(
        'DELETE FROM cloud_revisions WHERE pack_id=? AND revision NOT IN(SELECT revision FROM cloud_revisions WHERE pack_id=? ORDER BY revision DESC LIMIT 10)'
      )
      .bind(row.pack_id, row.pack_id),
    db
      .prepare(
        'INSERT OR IGNORE INTO cloud_garbage(object_key,attempts,next_attempt) SELECT ?,0,0 WHERE NOT EXISTS(SELECT 1 FROM cloud_revisions WHERE object_key=?)'
      )
      .bind(row.object_key, row.object_key)
  ]);
  return (await receipt(db, op, requestFp)) ?? fail(onlyIfAbsent ? 412 : 503, onlyIfAbsent ? 'cloud_pack_exists' : 'commit_not_confirmed');
}
export async function maintenance(db: D1Database, bucket: R2Bucket) {
  const now = Date.now();
  await db
    .prepare(
      'INSERT OR IGNORE INTO cloud_garbage(object_key,attempts,next_attempt) SELECT object_key,0,0 FROM cloud_objects o WHERE created_at<? AND NOT EXISTS(SELECT 1 FROM cloud_revisions r WHERE r.object_key=o.object_key)'
    )
    .bind(now - 86400000)
    .run();
  const rows = await db
    .prepare('SELECT object_key,attempts FROM cloud_garbage WHERE next_attempt<=? LIMIT 20')
    .bind(now)
    .all<{ object_key: string; attempts: number }>();
  for (const r of rows.results) {
    if (await db.prepare('SELECT 1 FROM cloud_revisions WHERE object_key=? LIMIT 1').bind(r.object_key).first()) {
      await db.prepare('DELETE FROM cloud_garbage WHERE object_key=?').bind(r.object_key).run();
      continue;
    }
    try {
      await bucket.delete(r.object_key);
      await db.batch([
        db.prepare('DELETE FROM cloud_garbage WHERE object_key=?').bind(r.object_key),
        db.prepare('DELETE FROM cloud_objects WHERE object_key=?').bind(r.object_key)
      ]);
    } catch {
      await db
        .prepare('UPDATE cloud_garbage SET attempts=attempts+1,next_attempt=? WHERE object_key=?')
        .bind(now + Math.min(86400000, 1000 * 2 ** Math.min(r.attempts, 16)), r.object_key)
        .run();
    }
  }
}
// Bound validation memory per isolate; D1 still serializes commits across isolates.
let uploads = Promise.resolve();
let nextMaintenance = 0;
async function serialized<T>(work: () => Promise<T>): Promise<T> {
  const previous = uploads;
  let unlock!: () => void;
  uploads = new Promise<void>((r) => {
    unlock = r;
  });
  await previous;
  try {
    return await work();
  } finally {
    unlock();
  }
}
export async function syncApi(request: Request, env: SyncEnv, ctx?: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
  const url = new URL(request.url),
    origin = request.headers.get('origin');
  const allowed = new Set(
    (env.ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );
  const cors = origin === null || origin === url.origin || allowed.has(origin) || (origin === 'null' && env.ALLOW_NULL_ORIGIN === 'true');
  const headers = new Headers({ 'Cache-Control': 'no-store', Vary: 'Origin', 'X-Content-Type-Options': 'nosniff' });
  if (cors && origin !== null) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Expose-Headers', 'X-Content-SHA256, X-Content-Fingerprint, Retry-After, Content-Disposition');
  }
  const json = (value: unknown, status = 200) => {
    const h = new Headers(headers);
    h.set('Content-Type', 'application/json; charset=utf-8');
    return new Response(JSON.stringify(value), { status, headers: h });
  };
  try {
    if (!cors) fail(403, 'origin_not_allowed');
    if (request.method === 'OPTIONS') {
      const method = request.headers.get('access-control-request-method');
      const fields = (request.headers.get('access-control-request-headers') ?? '')
        .toLowerCase()
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (
        !origin ||
        !['GET', 'POST'].includes(method ?? '') ||
        fields.some((h) => !['authorization', 'content-type', 'idempotency-key', 'x-content-fingerprint', 'if-none-match'].includes(h))
      )
        fail(403, 'preflight_not_allowed');
      headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key, X-Content-Fingerprint, If-None-Match');
      headers.set('Access-Control-Max-Age', '60');
      return new Response(null, { status: 204, headers });
    }
    if (!env.DB || !env.BUCKET || !env.SYNC_PASSPHRASE) fail(503, 'not_configured');
    const db = env.DB!,
      bucket = env.BUCKET!,
      secret = env.SYNC_PASSPHRASE!;
    const state = await init(db, secret);
    if (url.pathname === '/api/v1/health' && request.method === 'GET') {
      await bucket.head('__health__');
      return json({ ok: true, maxZipBytes: MAX_ZIP, protocol: 1 });
    }
    if (url.pathname === '/api/v1/auth/login' && request.method === 'POST') {
      const ip = await sha256(enc.encode(secret + ':' + (request.headers.get('cf-connecting-ip') ?? 'unknown')).buffer);
      await rate(db, 'login:' + ip, 5, 300);
      await rate(db, 'login:all', 100, 300);
      const body = await readSmallJson(request);
      if (typeof body?.passphrase !== 'string' || typeof body?.deviceName !== 'string' || body.deviceName.length > 100)
        fail(400, 'invalid_login');
      const a = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(secret))),
        b = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(body.passphrase)));
      let diff = 0;
      for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
      if (diff) fail(401, 'invalid_passphrase');
      const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');
      await db
        .prepare('INSERT INTO cloud_sessions(token_hash,epoch,device_name,created_at) VALUES(?,?,?,?)')
        .bind(await sha256(enc.encode(token).buffer), state.epoch, body.deviceName, Date.now())
        .run();
      return json({ token, expiresAt: null });
    }
    const bearer = request.headers.get('authorization')?.match(/^Bearer ([a-f0-9]{64})$/);
    if (!bearer) fail(401, 'bearer_required');
    const tokenHash = await sha256(enc.encode(bearer![1]).buffer);
    const session = await db
      .prepare('SELECT device_name FROM cloud_sessions WHERE token_hash=? AND epoch=(SELECT epoch FROM cloud_library WHERE id=1)')
      .bind(tokenHash)
      .first<{ device_name: string }>();
    if (!session) fail(401, 'invalid_session');
    if (ctx && Date.now() >= nextMaintenance) {
      nextMaintenance = Date.now() + 60000;
      ctx.waitUntil(maintenance(db, bucket).catch(() => undefined));
    }
    if (url.pathname === '/api/v1/auth/me' && request.method === 'GET')
      return json({ authenticated: true, deviceName: session!.device_name, expiresAt: null });
    if (url.pathname === '/api/v1/auth/logout' && request.method === 'POST') {
      await db.prepare('DELETE FROM cloud_sessions WHERE token_hash=?').bind(tokenHash).run();
      return json({ revoked: true });
    }
    if (url.pathname === '/api/v1/auth/logout-all' && request.method === 'POST') {
      await db.prepare('UPDATE cloud_library SET epoch=epoch+1 WHERE id=1').run();
      return json({ revoked: true });
    }
    if (url.pathname === '/api/v1/packs' && request.method === 'GET') {
      const after = url.searchParams.get('after') ?? '';
      const statement = db
        .prepare(
          'SELECT ' +
            columns +
            ' FROM cloud_heads h JOIN cloud_revisions r ON h.pack_id=r.pack_id AND h.revision=r.revision WHERE h.pack_id>? ORDER BY h.pack_id LIMIT 101'
        )
        .bind(after);
      const [rows, clock] = await db.batch([statement, db.prepare('SELECT seq FROM cloud_library WHERE id=1')]);
      const page = (rows.results as Row[]).slice(0, 100);
      const current = clock.results[0] as { seq: number };
      return json({
        packs: page.map(metadata),
        nextCursor: rows.results.length > 100 ? page[page.length - 1].pack_id : null,
        sequence: current!.seq
      });
    }
    const match = url.pathname.match(/^\/api\/v1\/packs\/([^/]+)\/(revisions(?:\/(\d+)\/download)?|restore)$/);
    if (!match) fail(404, 'not_found');
    let packId = '';
    try {
      packId = decodeURIComponent(match![1]);
    } catch {
      fail(400, 'invalid_pack_id');
    }
    if (!packId || packId.length > 200 || /[\x00-\x1f]/.test(packId)) fail(400, 'invalid_pack_id');
    if (match![3] && request.method === 'GET') {
      const row = await db
        .prepare('SELECT ' + columns + ' FROM cloud_revisions r WHERE pack_id=? AND revision=?')
        .bind(packId, Number(match![3]))
        .first<Row>();
      if (!row) fail(404, 'revision_not_found');
      const object = await bucket.get(row!.object_key);
      if (!object) {
        await db
          .prepare("INSERT OR REPLACE INTO cloud_faults(object_key,detected_at,reason) VALUES(?,?,'missing_object')")
          .bind(row!.object_key, Date.now())
          .run();
        fail(503, 'storage_inconsistent');
      }
      headers.set('Content-Type', 'application/zip');
      headers.set('Content-Length', String(object!.size));
      headers.set('X-Content-SHA256', row!.sha256);
      headers.set('X-Content-Fingerprint', row!.fingerprint);
      headers.set('Content-Disposition', 'attachment; filename="pack.loopdeck.zip"');
      return new Response(object!.body, { headers });
    }
    if (match![2] === 'revisions' && request.method === 'GET') {
      const rows = await db
        .prepare('SELECT ' + columns + ' FROM cloud_revisions r WHERE pack_id=? ORDER BY revision DESC LIMIT 10')
        .bind(packId)
        .all<Row>();
      return json({ revisions: rows.results.map(metadata) });
    }
    if (request.method !== 'POST') fail(405, 'method_not_allowed');
    const op = request.headers.get('idempotency-key') ?? '';
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(op)) fail(400, 'idempotency_key_required');
    await rate(db, 'upload:' + tokenHash, 60, 3600);
    await rate(db, 'upload:all', 240, 3600);
    let response: unknown;
    if (match![2] === 'restore') {
      const body = await readSmallJson(request);
      if (!Number.isSafeInteger(body?.revision) || body.revision < 1) fail(400, 'invalid_revision');
      const requestFp = 'restore:' + packId + ':' + body.revision;
      const cached = await receipt(db, op, requestFp);
      if (cached) return json(cached);
      const source = await db
        .prepare('SELECT ' + columns + ' FROM cloud_revisions r WHERE pack_id=? AND revision=?')
        .bind(packId, body.revision)
        .first<Row>();
      if (!source) fail(404, 'revision_not_found');
      const object = await bucket.get(source!.object_key);
      if (!object) fail(503, 'storage_inconsistent');
      // A retained revision may be pruned concurrently. Never resurrect its old
      // object key after GC has checked references; stage a fresh immutable key.
      const key = 'v1/' + crypto.randomUUID() + '.zip';
      await db.prepare('INSERT INTO cloud_objects(object_key,created_at) VALUES(?,?)').bind(key, Date.now()).run();
      await bucket.put(key, object!.body, { httpMetadata: { contentType: 'application/zip' } });
      response = await commit(db, op, requestFp, { ...source!, object_key: key }, true);
    } else if (match![2] === 'revisions') {
      if (!['application/zip', 'application/octet-stream'].includes((request.headers.get('content-type') ?? '').split(';')[0]))
        fail(415, 'zip_content_type_required');
      response = await serialized(async () => {
        const buffer = await readBounded(request, MAX_ZIP);
        const hash = await sha256(buffer);
        const validation = await importLoopDeckZip(
          { name: 'pack.loopdeck.zip', size: buffer.byteLength, arrayBuffer: async () => buffer } as File,
          true
        );
        if (!validation.ok || !validation.pack) fail(422, 'invalid_pack_zip');
        if (validation.pack!.packId !== packId) fail(422, 'pack_id_mismatch');
        let fp = '';
        try {
          fp = await contentFingerprint(validation.pack!, validation.assets ?? []);
        } catch {
          fail(422, 'invalid_pack_assets');
        }
        const supplied = request.headers.get('x-content-fingerprint');
        if (supplied && supplied !== fp) fail(422, 'fingerprint_mismatch');
        const onlyIfAbsent = request.headers.get('if-none-match') === '*';
        const requestFp = (onlyIfAbsent ? 'create:' : 'upload:') + packId + ':' + fp;
        const cached = await receipt(db, op, requestFp);
        if (cached) return cached;
        const key = 'v1/' + crypto.randomUUID() + '.zip';
        await db.prepare('INSERT INTO cloud_objects(object_key,created_at) VALUES(?,?)').bind(key, Date.now()).run();
        await bucket.put(key, buffer, { httpMetadata: { contentType: 'application/zip' } });
        const head = await db
          .prepare(
            'SELECT ' +
              columns +
              ' FROM cloud_heads h JOIN cloud_revisions r ON h.pack_id=r.pack_id AND h.revision=r.revision WHERE h.pack_id=?'
          )
          .bind(packId)
          .first<Row>();
        const repair = !!head && head.fingerprint === fp && !(await bucket.head(head.object_key));
        return commit(
          db,
          op,
          requestFp,
          {
            pack_id: packId,
            fingerprint: fp,
            sha256: hash,
            size: buffer.byteLength,
            object_key: key,
            title: validation.pack!.title,
            questions: validation.pack!.questions.length
          },
          repair,
          onlyIfAbsent
        );
      });
    } else fail(404, 'not_found');
    if (ctx) ctx.waitUntil(maintenance(db, bucket).catch(() => undefined));
    return json(response, 201);
  } catch (e) {
    if (e instanceof HttpError) {
      const retry = (e as HttpError & { retryAfter?: number }).retryAfter;
      if (retry) headers.set('Retry-After', String(retry));
      return json({ error: e.code }, e.status);
    }
    return json({ error: 'internal_error' }, 500);
  }
}
