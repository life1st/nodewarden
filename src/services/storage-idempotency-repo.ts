export interface IdempotencyRecord {
  userId: string;
  idempotencyKey: string;
  requestHash: string;
  status: number;
  responseBody: string | null;
  createdAt: number;
  expiresAt: number;
}

/**
 * Computes a SHA-256 hash of the incoming request body.
 */
export async function computeRequestHash(rawBody: string | ArrayBuffer): Promise<string> {
  const bytes = typeof rawBody === 'string' ? new TextEncoder().encode(rawBody) : new Uint8Array(rawBody);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Reads an existing idempotency record if present and not expired.
 * D1-305: Expired records return null, allowing the key to be reused.
 */
export async function getIdempotencyRecord(
  db: D1Database,
  userId: string,
  idempotencyKey: string,
  nowMs: number = Date.now()
): Promise<IdempotencyRecord | null> {
  const row = await db
    .prepare(
      'SELECT user_id, idempotency_key, request_hash, status, response_body, created_at, expires_at ' +
      'FROM request_idempotency WHERE user_id = ? AND idempotency_key = ?'
    )
    .bind(userId, idempotencyKey)
    .first<{
      user_id: string;
      idempotency_key: string;
      request_hash: string;
      status: number;
      response_body: string | null;
      created_at: number;
      expires_at: number;
    }>();

  if (!row) return null;

  if (row.expires_at <= nowMs) {
    return null;
  }

  return {
    userId: row.user_id,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    status: Number(row.status),
    responseBody: row.response_body ?? null,
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
  };
}

/**
 * Prepares the idempotency upsert statement to be batched with creation writes.
 */
export function buildSaveIdempotencyStatement(
  db: D1Database,
  record: IdempotencyRecord
): D1PreparedStatement {
  return db
    .prepare(
      'INSERT INTO request_idempotency(user_id, idempotency_key, request_hash, status, response_body, created_at, expires_at) ' +
      'VALUES(?, ?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT(user_id, idempotency_key) DO UPDATE SET ' +
      'request_hash = excluded.request_hash, status = excluded.status, response_body = excluded.response_body, created_at = excluded.created_at, expires_at = excluded.expires_at'
    )
    .bind(
      record.userId,
      record.idempotencyKey,
      record.requestHash,
      record.status,
      record.responseBody,
      record.createdAt,
      record.expiresAt
    );
}

export async function saveIdempotencyRecord(
  db: D1Database,
  record: IdempotencyRecord
): Promise<void> {
  await buildSaveIdempotencyStatement(db, record).run();
}

export async function deleteIdempotencyRecord(
  db: D1Database,
  userId: string,
  idempotencyKey: string
): Promise<void> {
  await db
    .prepare('DELETE FROM request_idempotency WHERE user_id = ? AND idempotency_key = ?')
    .bind(userId, idempotencyKey)
    .run();
}

/**
 * Cleans up expired idempotency records.
 */
export async function pruneExpiredIdempotency(
  db: D1Database,
  nowMs: number = Date.now()
): Promise<number> {
  const result = await db
    .prepare('DELETE FROM request_idempotency WHERE expires_at <= ?')
    .bind(nowMs)
    .run();
  return result.meta.changes ?? 0;
}
