import { Env } from '../types';
import { deleteBlobObject } from './blob-store';

export interface PendingAttachmentCleanup {
  id: string;
  userId: string;
  cipherId: string;
  attachmentId: string;
  blobKey: string;
  retryCount: number;
  createdAt: number;
  lastError: string | null;
}

/**
 * Records failed blob deletion attempts as cleanup tasks.
 * D1-304: Ensures no orphaned R2 objects remain permanently when delete fails.
 */
export async function recordPendingAttachmentCleanups(
  db: D1Database,
  userId: string,
  cipherId: string,
  failedBlobs: { attachmentId: string; blobKey: string; error?: string }[]
): Promise<void> {
  if (!failedBlobs.length) return;
  const now = Date.now();
  const statements: D1PreparedStatement[] = failedBlobs.map((blob) =>
    db
      .prepare(
        'INSERT INTO pending_attachment_cleanups(id, user_id, cipher_id, attachment_id, blob_key, retry_count, created_at, last_error) ' +
        'VALUES(?, ?, ?, ?, ?, 0, ?, ?)'
      )
      .bind(
        crypto.randomUUID(),
        userId,
        cipherId,
        blob.attachmentId,
        blob.blobKey,
        now,
        blob.error ?? null
      )
  );
  await db.batch(statements);
}

export async function getPendingAttachmentCleanups(
  db: D1Database,
  limit: number = 50
): Promise<PendingAttachmentCleanup[]> {
  const result = await db
    .prepare(
      'SELECT id, user_id, cipher_id, attachment_id, blob_key, retry_count, created_at, last_error ' +
      'FROM pending_attachment_cleanups ORDER BY retry_count ASC, created_at ASC LIMIT ?'
    )
    .bind(limit)
    .all<{
      id: string;
      user_id: string;
      cipher_id: string;
      attachment_id: string;
      blob_key: string;
      retry_count: number;
      created_at: number;
      last_error: string | null;
    }>();

  return (result.results || []).map((row) => ({
    id: row.id,
    userId: row.user_id,
    cipherId: row.cipher_id,
    attachmentId: row.attachment_id,
    blobKey: row.blob_key,
    retryCount: Number(row.retry_count),
    createdAt: Number(row.created_at),
    lastError: row.last_error ?? null,
  }));
}

export async function deletePendingAttachmentCleanup(
  db: D1Database,
  id: string
): Promise<void> {
  await db
    .prepare('DELETE FROM pending_attachment_cleanups WHERE id = ?')
    .bind(id)
    .run();
}

export async function incrementPendingAttachmentCleanupRetry(
  db: D1Database,
  id: string,
  lastError?: string
): Promise<void> {
  await db
    .prepare(
      'UPDATE pending_attachment_cleanups SET retry_count = retry_count + 1, last_error = ? WHERE id = ?'
    )
    .bind(lastError ?? null, id)
    .run();
}

/**
 * Retries deleting pending attachment blobs from R2.
 */
export async function processPendingAttachmentCleanups(
  env: Env,
  db: D1Database,
  limit: number = 50
): Promise<{ processed: number; succeeded: number; failed: number }> {
  const tasks = await getPendingAttachmentCleanups(db, limit);
  let succeeded = 0;
  let failed = 0;

  for (const task of tasks) {
    try {
      await deleteBlobObject(env, task.blobKey);
      await deletePendingAttachmentCleanup(db, task.id);
      succeeded++;
    } catch (err: unknown) {
      failed++;
      await incrementPendingAttachmentCleanupRetry(
        db,
        task.id,
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  return { processed: tasks.length, succeeded, failed };
}
