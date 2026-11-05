// D1-303: the per-user sync revision is a strictly increasing integer
// millisecond stamp.
// - `revision_ms` is authoritative and advances with
//   next = max(now, previous + 1), so two writes can never land on the same
//   value even inside one millisecond and a clock that moves backwards cannot
//   roll the revision back.
// - `revision_date` stays in sync as an ISO-8601 string for older clients,
//   notification payloads and the sync cache key. It is kept for rollback.

const REVISION_ISO_FORMAT = '%Y-%m-%dT%H:%M:%fZ';
// Both SET arms must re-evaluate the same expression: SQLite reads the
// pre-update row for every right-hand side, so they always agree.
const MONOTONIC_MS_SQL = 'MAX(excluded.revision_ms, user_revisions.revision_ms + 1)';
const REVISION_UPSERT_SET_SQL =
  `revision_ms = ${MONOTONIC_MS_SQL}, ` +
  `revision_date = strftime('${REVISION_ISO_FORMAT}', ${MONOTONIC_MS_SQL} / 1000.0, 'unixepoch')`;

interface RevisionRow {
  revision_date: string;
  revision_ms: number | null;
}

function normalizeRevisionMs(revisionMs: number): number {
  return Number.isFinite(revisionMs) && revisionMs > 0 ? Math.floor(revisionMs) : Date.now();
}

function toRevisionIso(revisionMs: number): string {
  return new Date(revisionMs).toISOString();
}

function readRevisionMs(row: RevisionRow | null | undefined, fallbackMs: number): number {
  const stored = Number(row?.revision_ms);
  if (Number.isFinite(stored) && stored > 0) return stored;
  // Rows restored from a backup (or written before this migration) only carry
  // the ISO column; derive the stamp from it instead of inventing a new one.
  const parsed = Date.parse(String(row?.revision_date ?? ''));
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return fallbackMs;
}

function readRevisionIso(row: RevisionRow | null | undefined, fallbackMs: number): string {
  const stored = Number(row?.revision_ms);
  if (Number.isFinite(stored) && stored > 0) return toRevisionIso(stored);
  if (row?.revision_date) return row.revision_date;
  return toRevisionIso(fallbackMs);
}

export function buildRevisionSelectStatement(db: D1Database, userId: string): D1PreparedStatement {
  return db.prepare('SELECT revision_date, revision_ms FROM user_revisions WHERE user_id = ?').bind(userId);
}

export function buildRevisionUpsertStatement(
  db: D1Database,
  userId: string,
  revisionMs: number
): D1PreparedStatement {
  const safeMs = normalizeRevisionMs(revisionMs);
  return db
    .prepare(
      'INSERT INTO user_revisions(user_id, revision_date, revision_ms) VALUES(?, ?, ?) ' +
        `ON CONFLICT(user_id) DO UPDATE SET ${REVISION_UPSERT_SET_SQL}`
    )
    .bind(userId, toRevisionIso(safeMs), safeMs);
}

/**
 * D1-201 / D1-303: revision upsert that only takes effect when `guardSql`
 * matches a row. Inside a `db.batch()` the statement runs alongside the guarded
 * write, so a losing conditional update (or a folder another request already
 * changed) never bumps the user revision.
 */
export function buildRevisionUpsertIfStatement(
  db: D1Database,
  userId: string,
  revisionMs: number,
  guardSql: string,
  ...guardParams: any[]
): D1PreparedStatement {
  const safeMs = normalizeRevisionMs(revisionMs);
  return db
    .prepare(
      'INSERT INTO user_revisions(user_id, revision_date, revision_ms) ' +
        `SELECT ?, ?, ? WHERE EXISTS (${guardSql}) ` +
        `ON CONFLICT(user_id) DO UPDATE SET ${REVISION_UPSERT_SET_SQL}`
    )
    .bind(userId, toRevisionIso(safeMs), safeMs, ...guardParams);
}

// Creates the row when it is missing and returns whatever is stored, so a
// racing first write cannot be masked by a locally computed stamp.
async function ensureRevisionRow(db: D1Database, userId: string): Promise<RevisionRow | undefined> {
  const nowMs = Date.now();
  const results = await db.batch([
    db
      .prepare(
        'INSERT INTO user_revisions(user_id, revision_date, revision_ms) VALUES(?, ?, ?) ' +
          'ON CONFLICT(user_id) DO NOTHING'
      )
      .bind(userId, toRevisionIso(nowMs), nowMs),
    buildRevisionSelectStatement(db, userId),
  ]);
  return results[1]?.results?.[0] as RevisionRow | undefined;
}

export async function getRevisionMs(db: D1Database, userId: string): Promise<number> {
  const row = await buildRevisionSelectStatement(db, userId).first<RevisionRow>();
  if (row) return readRevisionMs(row, Date.now());
  return readRevisionMs(await ensureRevisionRow(db, userId), Date.now());
}

export async function getRevisionDate(db: D1Database, userId: string): Promise<string> {
  const row = await buildRevisionSelectStatement(db, userId).first<RevisionRow>();
  if (row) return readRevisionIso(row, Date.now());
  return readRevisionIso(await ensureRevisionRow(db, userId), Date.now());
}

/**
 * Advances the user revision monotonically and returns the stored value.
 * The upsert and the read-back travel in one `db.batch()` so callers still pay
 * a single D1 round trip while receiving the value SQL actually wrote.
 */
export async function updateRevisionMs(db: D1Database, userId: string): Promise<number> {
  const nowMs = Date.now();
  const results = await db.batch([
    buildRevisionUpsertStatement(db, userId, nowMs),
    buildRevisionSelectStatement(db, userId),
  ]);
  const row = results[1]?.results?.[0] as RevisionRow | undefined;
  return readRevisionMs(row, nowMs);
}

export async function updateRevisionDate(db: D1Database, userId: string): Promise<string> {
  return toRevisionIso(await updateRevisionMs(db, userId));
}
