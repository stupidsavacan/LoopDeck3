import { sqliteTable, text, integer, primaryKey, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
export const library = sqliteTable('cloud_library', {
  id: integer('id').primaryKey(),
  secretStamp: text('secret_stamp').notNull(),
  epoch: integer('epoch').notNull(),
  seq: integer('seq').notNull()
});
export const sessions = sqliteTable('cloud_sessions', {
  tokenHash: text('token_hash').primaryKey(),
  epoch: integer('epoch').notNull(),
  deviceName: text('device_name').notNull(),
  createdAt: integer('created_at').notNull()
});
export const heads = sqliteTable('cloud_heads', { packId: text('pack_id').primaryKey(), revision: integer('revision').notNull() });
export const revisions = sqliteTable(
  'cloud_revisions',
  {
    packId: text('pack_id').notNull(),
    revision: integer('revision').notNull(),
    fingerprint: text('fingerprint').notNull(),
    sha256: text('sha256').notNull(),
    size: integer('size').notNull(),
    objectKey: text('object_key').notNull(),
    title: text('title').notNull(),
    questions: integer('questions').notNull(),
    committedAt: text('committed_at').notNull(),
    opId: text('op_id').notNull()
  },
  (t) => [
    primaryKey({ columns: [t.packId, t.revision] }),
    uniqueIndex('cloud_revision_operation').on(t.opId),
    index('cloud_revision_object').on(t.objectKey)
  ]
);
export const receipts = sqliteTable('cloud_receipts', {
  opId: text('op_id').primaryKey(),
  requestFp: text('request_fp').notNull(),
  result: text('result')
});
export const objects = sqliteTable('cloud_objects', {
  objectKey: text('object_key').primaryKey(),
  createdAt: integer('created_at').notNull()
});
export const garbage = sqliteTable('cloud_garbage', {
  objectKey: text('object_key').primaryKey(),
  attempts: integer('attempts').notNull().default(0),
  nextAttempt: integer('next_attempt').notNull()
});
export const limits = sqliteTable('cloud_limits', {
  key: text('key').primaryKey(),
  count: integer('count').notNull(),
  resetAt: integer('reset_at').notNull()
});
export const faults = sqliteTable('cloud_faults', {
  objectKey: text('object_key').primaryKey(),
  detectedAt: integer('detected_at').notNull(),
  reason: text('reason').notNull()
});
