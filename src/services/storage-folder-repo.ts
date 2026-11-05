import type { Folder } from '../types';

function mapFolderRow(row: any): Folder {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getFolder(db: D1Database, id: string): Promise<Folder | null> {
  const row = await db
    .prepare('SELECT id, user_id, name, created_at, updated_at FROM folders WHERE id = ?')
    .bind(id)
    .first<any>();
  if (!row) return null;
  return mapFolderRow(row);
}

export async function getFolderForUser(db: D1Database, id: string, userId: string): Promise<Folder | null> {
  const row = await db
    .prepare('SELECT id, user_id, name, created_at, updated_at FROM folders WHERE id = ? AND user_id = ?')
    .bind(id, userId)
    .first<any>();
  if (!row) return null;
  return mapFolderRow(row);
}

export async function saveFolder(db: D1Database, folder: Folder): Promise<void> {
  await db
    .prepare(
      'INSERT INTO folders(id, user_id, name, created_at, updated_at) VALUES(?, ?, ?, ?, ?) ' +
      'ON CONFLICT(id) DO UPDATE SET name=excluded.name, updated_at=excluded.updated_at WHERE user_id=excluded.user_id'
    )
    .bind(folder.id, folder.userId, folder.name, folder.createdAt, folder.updatedAt)
    .run();
}

// D1-302: a rename only lands when the folder still carries the version the
// handler read, so two concurrent renames cannot silently overwrite each other.
export async function updateFolderIfUnchanged(
  db: D1Database,
  folder: Folder,
  expectedUpdatedAt: string
): Promise<boolean> {
  const result = await db
    .prepare('UPDATE folders SET name = ?, updated_at = ? WHERE id = ? AND user_id = ? AND updated_at = ?')
    .bind(folder.name, folder.updatedAt, folder.id, folder.userId, expectedUpdatedAt)
    .run();
  return result.meta.changes === 1;
}

export function buildDeleteFolderStatement(
  db: D1Database,
  userId: string,
  folderId: string,
  expectedUpdatedAt: string
): D1PreparedStatement {
  return db
    .prepare('DELETE FROM folders WHERE id = ? AND user_id = ? AND updated_at = ?')
    .bind(folderId, userId, expectedUpdatedAt);
}

// The reference cleanup must move every touched cipher past the version a
// concurrent writer could already be holding: max(now, current + 1ms). SQLite
// evaluates the SET clause against the pre-update row, so this reads the stored
// value; an unparseable timestamp makes the comparison -1 and falls back to
// `now`. Without the strict bump a write that raced with the folder delete
// could match the unchanged version and restore a dangling folderId.
const NEXT_CIPHER_VERSION_SQL =
  "strftime('%Y-%m-%dT%H:%M:%fZ', (" +
  'CASE WHEN COALESCE(CAST(strftime(\'%s\', updated_at) AS INTEGER) * 1000 + ' +
  "CAST(substr(updated_at, 21, 3) AS INTEGER), -1) >= ? " +
  "THEN CAST(strftime('%s', updated_at) AS INTEGER) * 1000 + " +
  'CAST(substr(updated_at, 21, 3) AS INTEGER) + 1 ' +
  'ELSE ? END) / 1000.0, \'unixepoch\')';

export function buildClearFolderFromCiphersStatement(
  db: D1Database,
  userId: string,
  folderId: string,
  nowMs: number,
  expectedUpdatedAt: string
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE ciphers
       SET folder_id = NULL, updated_at = ${NEXT_CIPHER_VERSION_SQL},
           data = json_remove(data, '$.folderId', '$.folder_id', '$.updatedAt', '$.revisionDate')
       WHERE user_id = ?
         AND (
           folder_id = ?
           OR json_extract(data, '$.folderId') = ?
           OR json_extract(data, '$.folder_id') = ?
         )
         AND EXISTS (
           SELECT 1 FROM folders
           WHERE id = ? AND user_id = ? AND updated_at = ?
         )`
    )
    .bind(nowMs, nowMs, userId, folderId, folderId, folderId, folderId, userId, expectedUpdatedAt);
}

export async function bulkDeleteFolders(
  db: D1Database,
  userId: string,
  ids: string[],
  sqlChunkSize: (fixedBindCount: number, bindCountPerItem?: number) => number,
  updateRevisionDate: (userId: string) => Promise<string>
): Promise<string | null> {
  const uniqueIds = Array.from(new Set(ids.map((id) => String(id || '').trim()).filter(Boolean)));
  if (!uniqueIds.length) return null;

  const now = new Date().toISOString();
  // Each folder ID is bound in all three compatibility predicates below.
  const chunkSize = sqlChunkSize(2, 3);
  const statements: D1PreparedStatement[] = [];

  for (let i = 0; i < uniqueIds.length; i += chunkSize) {
    const chunk = uniqueIds.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => '?').join(',');
    statements.push(
      db.prepare(
        `UPDATE ciphers
         SET folder_id = NULL, updated_at = ?,
             data = json_remove(data, '$.folderId', '$.folder_id', '$.updatedAt', '$.revisionDate')
         WHERE user_id = ?
           AND (
             folder_id IN (${placeholders})
             OR json_extract(data, '$.folderId') IN (${placeholders})
             OR json_extract(data, '$.folder_id') IN (${placeholders})
           )`
      )
      .bind(now, userId, ...chunk, ...chunk, ...chunk)
    );
    statements.push(
      db.prepare(`DELETE FROM folders WHERE user_id = ? AND id IN (${placeholders})`)
        .bind(userId, ...chunk)
    );
  }

  await db.batch(statements);

  return updateRevisionDate(userId);
}

export async function getAllFolders(db: D1Database, userId: string): Promise<Folder[]> {
  const res = await db
    .prepare('SELECT id, user_id, name, created_at, updated_at FROM folders WHERE user_id = ? ORDER BY updated_at DESC')
    .bind(userId)
    .all<any>();
  return (res.results || []).map((row) => mapFolderRow(row));
}

export async function getFoldersPage(db: D1Database, userId: string, limit: number, offset: number): Promise<Folder[]> {
  const res = await db
    .prepare(
      'SELECT id, user_id, name, created_at, updated_at FROM folders WHERE user_id = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?'
    )
    .bind(userId, limit, offset)
    .all<any>();
  return (res.results || []).map((row) => mapFolderRow(row));
}
