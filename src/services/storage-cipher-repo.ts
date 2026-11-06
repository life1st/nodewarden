import type { Cipher } from '../types';
import { buildRevisionSelectStatement, buildRevisionUpsertStatement } from './storage-revision-repo';

function normalizeOptionalId(value: unknown): string | null {
  if (value == null) return null;
  const normalized = String(value).trim();
  return normalized ? normalized : null;
}

type SafeBind = (stmt: D1PreparedStatement, ...values: any[]) => D1PreparedStatement;
type SqlChunkSize = (fixedBindCount: number) => number;

export interface BulkCipherMutationResult {
  revisionDate: string | null;
  completedCount: number;
  totalCount: number;
  failed: boolean;
}

interface CipherRow {
  id: string;
  user_id: string;
  type: number | null;
  folder_id: string | null;
  name: string | null;
  notes: string | null;
  favorite: number | null;
  data: string;
  reprompt: number | null;
  key: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  deleted_at: string | null;
}

const CIPHER_SCALAR_DATA_KEYS = new Set([
  'id',
  'userId',
  'user_id',
  'type',
  'folderId',
  'folder_id',
  'name',
  'notes',
  'favorite',
  'reprompt',
  'key',
  'attachments',
  'Attachments',
  'attachments2',
  'Attachments2',
  'createdAt',
  'created_at',
  'creationDate',
  'updatedAt',
  'updated_at',
  'revisionDate',
  'lastKnownRevisionDate',
  'LastKnownRevisionDate',
  'archivedAt',
  'archived_at',
  'archivedDate',
  'deletedAt',
  'deleted_at',
  'deletedDate',
]);

function buildCipherData(cipher: Cipher, folderId: string | null): string {
  const payload: Record<string, unknown> = {
    ...cipher,
    folderId,
  };
  for (const key of CIPHER_SCALAR_DATA_KEYS) {
    delete payload[key];
  }
  return JSON.stringify(payload);
}

function parseCipherRow(row: CipherRow | null | undefined): Cipher | null {
  if (!row?.data) return null;
  try {
    const parsed = JSON.parse(row.data) as Cipher;
    const folderId = normalizeOptionalId(row.folder_id ?? parsed.folderId ?? null);
    return {
      ...parsed,
      id: row.id,
      userId: row.user_id,
      type: Number(row.type) || Number(parsed.type) || 1,
      folderId,
      name: row.name ?? parsed.name ?? null,
      notes: row.notes ?? parsed.notes ?? null,
      favorite: row.favorite != null ? !!row.favorite : !!parsed.favorite,
      reprompt: row.reprompt ?? parsed.reprompt ?? 0,
      key: row.key ?? parsed.key ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      archivedAt: row.archived_at ?? parsed.archivedAt ?? parsed.archivedDate ?? null,
      deletedAt: row.deleted_at ?? parsed.deletedAt ?? parsed.deletedDate ?? null,
    };
  } catch {
    console.error('Corrupted cipher data, id:', row.id);
    return null;
  }
}

function selectCipherColumns(): string {
  return 'id, user_id, type, folder_id, name, notes, favorite, data, reprompt, key, created_at, updated_at, archived_at, deleted_at';
}

export async function getCipher(db: D1Database, id: string): Promise<Cipher | null> {
  const row = await db
    .prepare(`SELECT ${selectCipherColumns()} FROM ciphers WHERE id = ?`)
    .bind(id)
    .first<CipherRow>();
  return parseCipherRow(row);
}

export async function getCipherForUser(db: D1Database, id: string, userId: string): Promise<Cipher | null> {
  const row = await db
    .prepare(`SELECT ${selectCipherColumns()} FROM ciphers WHERE id = ? AND user_id = ?`)
    .bind(id, userId)
    .first<CipherRow>();
  return parseCipherRow(row);
}

export async function saveCipher(db: D1Database, safeBind: SafeBind, cipher: Cipher): Promise<void> {
  const folderId = normalizeOptionalId(cipher.folderId);
  const data = buildCipherData(cipher, folderId);
  const stmt = db.prepare(
    'INSERT INTO ciphers(id, user_id, type, folder_id, name, notes, favorite, data, reprompt, key, created_at, updated_at, archived_at, deleted_at) ' +
    'VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
    'ON CONFLICT(id) DO UPDATE SET ' +
    'type=excluded.type, folder_id=excluded.folder_id, name=excluded.name, notes=excluded.notes, favorite=excluded.favorite, data=excluded.data, reprompt=excluded.reprompt, key=excluded.key, updated_at=excluded.updated_at, archived_at=excluded.archived_at, deleted_at=excluded.deleted_at ' +
    'WHERE user_id=excluded.user_id'
  );
  await safeBind(
    stmt,
    cipher.id,
    cipher.userId,
    Number(cipher.type) || 1,
    folderId,
    cipher.name,
    cipher.notes,
    cipher.favorite ? 1 : 0,
    data,
    cipher.reprompt ?? 0,
    cipher.key,
    cipher.createdAt,
    cipher.updatedAt,
    cipher.archivedAt ?? null,
    cipher.deletedAt
  ).run();
}

// A single conditional UPDATE prevents a competing save or deletion between
// the handler's read and write from being overwritten (or resurrected).
export function buildCipherUpdateStatement(
  db: D1Database,
  safeBind: SafeBind,
  cipher: Cipher,
  expectedUpdatedAt: string
): D1PreparedStatement {
  const folderId = normalizeOptionalId(cipher.folderId);
  return safeBind(
    db.prepare(
      'UPDATE ciphers SET type=?, folder_id=?, name=?, notes=?, favorite=?, data=?, reprompt=?, key=?, updated_at=?, archived_at=?, deleted_at=? ' +
      'WHERE id=? AND user_id=? AND updated_at=?'
    ),
    Number(cipher.type) || 1, folderId, cipher.name, cipher.notes, cipher.favorite ? 1 : 0,
    buildCipherData(cipher, folderId), cipher.reprompt ?? 0, cipher.key, cipher.updatedAt,
    cipher.archivedAt ?? null, cipher.deletedAt, cipher.id, cipher.userId, expectedUpdatedAt
  );
}

export async function updateCipherIfUnchanged(
  db: D1Database,
  safeBind: SafeBind,
  cipher: Cipher,
  expectedUpdatedAt: string
): Promise<boolean> {
  const result = await buildCipherUpdateStatement(db, safeBind, cipher, expectedUpdatedAt).run();
  return result.meta.changes === 1;
}

// D1-205: compares exactly the values the conditional UPDATE would write, so a
// save that carries no real change can skip both the cipher write and the
// user revision bump. Updated-at is intentionally excluded: it is always a
// fresh monotonic timestamp for writes that do happen.
export function isCipherWriteUnchanged(next: Cipher, current: Cipher): boolean {
  const nextFolderId = normalizeOptionalId(next.folderId);
  const currentFolderId = normalizeOptionalId(current.folderId);
  return (
    (Number(next.type) || 1) === (Number(current.type) || 1) &&
    nextFolderId === currentFolderId &&
    (next.name ?? null) === (current.name ?? null) &&
    (next.notes ?? null) === (current.notes ?? null) &&
    !!next.favorite === !!current.favorite &&
    (next.reprompt ?? 0) === (current.reprompt ?? 0) &&
    (next.key ?? null) === (current.key ?? null) &&
    (next.archivedAt ?? null) === (current.archivedAt ?? null) &&
    (next.deletedAt ?? null) === (current.deletedAt ?? null) &&
    buildCipherData(next, nextFolderId) === buildCipherData(current, currentFolderId)
  );
}

function sanitizeIds(ids: string[]): string[] {
  return Array.from(new Set(ids.map((id) => String(id || '').trim()).filter(Boolean)));
}

export async function deleteCipher(db: D1Database, id: string, userId: string): Promise<void> {
  await db.prepare('DELETE FROM ciphers WHERE id = ? AND user_id = ?').bind(id, userId).run();
}

// D1-301: a permanent delete only removes the exact row the handler read, so a
// concurrent save or restore is reported as a conflict instead of being
// silently discarded.
export function buildCipherDeleteStatement(
  db: D1Database,
  id: string,
  userId: string,
  expectedUpdatedAt: string
): D1PreparedStatement {
  return db
    .prepare('DELETE FROM ciphers WHERE id = ? AND user_id = ? AND updated_at = ?')
    .bind(id, userId, expectedUpdatedAt);
}

type BuildBulkChunkStatement = (chunk: string[], placeholders: string, now: string) => D1PreparedStatement;
type BuildBulkPrecedingStatements = (chunk: string[], placeholders: string, now: string) => D1PreparedStatement[];

// D1 limit is enforced per statement, while `db.batch()` lets several
// statements travel in one round trip. Keeping the whole bulk in one batch
// (when it fits) turns the request count from linear in the selection size into
// a small constant; oversized bulks are split by statement count.
const MAX_D1_BATCH_STATEMENTS = 100;
const BULK_REVISION_STATEMENTS = 2;

/**
 * D1-204: executes a bulk cipher mutation and its revision bump chunk by
 * chunk. Each chunk runs in one `db.batch()`, so a failure rolls back exactly
 * that chunk and stops the remaining ones. The caller receives how many items
 * were processed before the failure so it can report a partial result.
 */
async function runBulkCipherMutation(
  db: D1Database,
  sqlChunkSize: SqlChunkSize,
  ids: string[],
  userId: string,
  fixedBindCount: number,
  buildStatement: BuildBulkChunkStatement,
  options: {
    precedingStatementsPerChunk?: number;
    buildPrecedingStatements?: BuildBulkPrecedingStatements;
  } = {}
): Promise<BulkCipherMutationResult> {
  const uniqueIds = sanitizeIds(ids);
  const totalCount = uniqueIds.length;
  if (!totalCount) {
    return { revisionDate: null, completedCount: 0, totalCount: 0, failed: false };
  }

  const now = new Date().toISOString();
  const idChunkSize = sqlChunkSize(fixedBindCount);
  const idChunks: string[][] = [];
  for (let i = 0; i < uniqueIds.length; i += idChunkSize) {
    idChunks.push(uniqueIds.slice(i, i + idChunkSize));
  }

  const statementsPerChunk = 1 + (options.precedingStatementsPerChunk ?? 0);
  const chunksPerBatch = Math.max(
    1,
    Math.floor((MAX_D1_BATCH_STATEMENTS - BULK_REVISION_STATEMENTS) / statementsPerChunk)
  );
  let completedCount = 0;
  let revisionDate: string | null = null;

  for (let i = 0; i < idChunks.length; i += chunksPerBatch) {
    const group = idChunks.slice(i, i + chunksPerBatch);
    const batchIds = group.flat();
    try {
      const results = await db.batch([
        ...group.flatMap((chunk) => {
          const placeholders = chunk.map(() => '?').join(',');
          return [
            ...(options.buildPrecedingStatements?.(chunk, placeholders, now) ?? []),
            buildStatement(chunk, placeholders, now),
          ];
        }),
        buildRevisionUpsertStatement(db, userId, Date.now()),
        buildRevisionSelectStatement(db, userId),
      ]);
      const revisionRow = results[results.length - 1]?.results?.[0] as { revision_date?: string } | undefined;
      revisionDate = rowRevisionDate(revisionRow) ?? revisionDate;
      completedCount += batchIds.length;
    } catch {
      return { revisionDate, completedCount, totalCount, failed: true };
    }
  }

  return { revisionDate, completedCount, totalCount, failed: false };
}

function rowRevisionDate(row: { revision_date?: string } | undefined): string | null {
  return row?.revision_date ?? null;
}


export async function bulkSoftDeleteCiphers(
  db: D1Database,
  sqlChunkSize: SqlChunkSize,
  ids: string[],
  userId: string
): Promise<BulkCipherMutationResult> {
  return runBulkCipherMutation(db, sqlChunkSize, ids, userId, 3, (chunk, placeholders, now) =>
    db
      .prepare(
        `UPDATE ciphers
         SET deleted_at = ?, updated_at = ?,
             data = json_remove(data, '$.deletedAt', '$.deletedDate', '$.updatedAt', '$.revisionDate')
         WHERE user_id = ? AND id IN (${placeholders})`
      )
      .bind(now, now, userId, ...chunk)
  );
}

export async function bulkRestoreCiphers(
  db: D1Database,
  sqlChunkSize: SqlChunkSize,
  ids: string[],
  userId: string
): Promise<BulkCipherMutationResult> {
  return runBulkCipherMutation(db, sqlChunkSize, ids, userId, 2, (chunk, placeholders, now) =>
    db
      .prepare(
        `UPDATE ciphers
         SET deleted_at = NULL, updated_at = ?,
             data = json_remove(data, '$.deletedAt', '$.deletedDate', '$.updatedAt', '$.revisionDate')
         WHERE user_id = ? AND id IN (${placeholders})`
      )
      .bind(now, userId, ...chunk)
  );
}

export async function bulkDeleteCiphers(
  db: D1Database,
  sqlChunkSize: SqlChunkSize,
  ids: string[],
  userId: string
): Promise<BulkCipherMutationResult> {
  return runBulkCipherMutation(
    db,
    sqlChunkSize,
    ids,
    userId,
    1,
    (chunk, placeholders) =>
      db.prepare(`DELETE FROM ciphers WHERE user_id = ? AND id IN (${placeholders})`).bind(userId, ...chunk),
    {
      precedingStatementsPerChunk: 1,
      // D1-202 / D1-204: attachment rows share the cipher delete transaction so
      // a failed chunk cannot leave ciphers without their metadata.
      buildPrecedingStatements: (chunk, placeholders) => [
        db
          .prepare(
            `DELETE FROM attachments
             WHERE cipher_id IN (${placeholders})
               AND EXISTS (
                 SELECT 1 FROM ciphers
                 WHERE ciphers.id = attachments.cipher_id AND ciphers.user_id = ?
               )`
          )
          .bind(...chunk, userId),
      ],
    }
  );
}

export async function getAllCiphers(db: D1Database, userId: string): Promise<Cipher[]> {
  const res = await db
    .prepare(`SELECT ${selectCipherColumns()} FROM ciphers WHERE user_id = ? ORDER BY updated_at DESC`)
    .bind(userId)
    .all<CipherRow>();
  return (res.results || []).flatMap((row) => {
    const cipher = parseCipherRow(row);
    return cipher ? [cipher] : [];
  });
}

export async function getCiphersPage(
  db: D1Database,
  userId: string,
  includeDeleted: boolean,
  limit: number,
  offset: number
): Promise<Cipher[]> {
  const whereDeleted = includeDeleted
    ? ''
    : "AND deleted_at IS NULL AND json_extract(data, '$.deletedAt') IS NULL AND json_extract(data, '$.deletedDate') IS NULL";
  const res = await db
    .prepare(
      `SELECT ${selectCipherColumns()} FROM ciphers
       WHERE user_id = ?
       ${whereDeleted}
       ORDER BY updated_at DESC
       LIMIT ? OFFSET ?`
    )
    .bind(userId, limit, offset)
    .all<CipherRow>();
  return (res.results || []).flatMap((row) => {
    const cipher = parseCipherRow(row);
    return cipher ? [cipher] : [];
  });
}

export async function getCiphersByIds(
  db: D1Database,
  sqlChunkSize: SqlChunkSize,
  ids: string[],
  userId: string
): Promise<Cipher[]> {
  if (ids.length === 0) return [];
  const uniqueIds = sanitizeIds(ids);
  if (!uniqueIds.length) return [];

  const chunkSize = sqlChunkSize(1);
  const out: Cipher[] = [];
  for (let i = 0; i < uniqueIds.length; i += chunkSize) {
    const chunk = uniqueIds.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => '?').join(',');
    const stmt = db.prepare(`SELECT ${selectCipherColumns()} FROM ciphers WHERE user_id = ? AND id IN (${placeholders})`);
    const res = await stmt.bind(userId, ...chunk).all<CipherRow>();
    out.push(
      ...(res.results || []).flatMap((row) => {
        const cipher = parseCipherRow(row);
        return cipher ? [cipher] : [];
      })
    );
  }
  return out;
}

export async function bulkMoveCiphers(
  db: D1Database,
  sqlChunkSize: SqlChunkSize,
  ids: string[],
  folderId: string | null,
  userId: string
): Promise<BulkCipherMutationResult> {
  const normalizedFolderId = normalizeOptionalId(folderId);
  return runBulkCipherMutation(db, sqlChunkSize, ids, userId, 3, (chunk, placeholders, now) =>
    db
      .prepare(
        `UPDATE ciphers
         SET folder_id = ?, updated_at = ?,
             data = json_remove(data, '$.folderId', '$.folder_id', '$.updatedAt', '$.revisionDate')
         WHERE user_id = ? AND id IN (${placeholders})`
      )
      .bind(normalizedFolderId, now, userId, ...chunk)
  );
}

export async function bulkArchiveCiphers(
  db: D1Database,
  sqlChunkSize: SqlChunkSize,
  ids: string[],
  userId: string
): Promise<BulkCipherMutationResult> {
  return runBulkCipherMutation(db, sqlChunkSize, ids, userId, 3, (chunk, placeholders, now) =>
    db
      .prepare(
        `UPDATE ciphers
         SET archived_at = ?, updated_at = ?,
             data = json_remove(data, '$.archivedAt', '$.archivedDate', '$.updatedAt', '$.revisionDate')
         WHERE user_id = ? AND id IN (${placeholders})
           AND deleted_at IS NULL
           AND json_extract(data, '$.deletedAt') IS NULL
           AND json_extract(data, '$.deletedDate') IS NULL`
      )
      .bind(now, now, userId, ...chunk)
  );
}

export async function bulkUnarchiveCiphers(
  db: D1Database,
  sqlChunkSize: SqlChunkSize,
  ids: string[],
  userId: string
): Promise<BulkCipherMutationResult> {
  return runBulkCipherMutation(db, sqlChunkSize, ids, userId, 2, (chunk, placeholders, now) =>
    db
      .prepare(
        `UPDATE ciphers
         SET archived_at = NULL, updated_at = ?,
             data = json_remove(data, '$.archivedAt', '$.archivedDate', '$.updatedAt', '$.revisionDate')
         WHERE user_id = ? AND id IN (${placeholders})`
      )
      .bind(now, userId, ...chunk)
  );
}
