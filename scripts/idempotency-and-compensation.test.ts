import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { StorageService } from '../src/services/storage';
import { handleAuthenticatedRoute } from '../src/router-authenticated';
import { bytesToBase64, encryptBw } from '../webapp/src/lib/crypto';
import { pruneExpiredIdempotency } from '../src/services/storage-idempotency-repo';

const owner = '00000000-0000-4000-8000-000000000001';
const enc = new Uint8Array(32).fill(1);
const mac = new Uint8Array(32).fill(2);
const encrypt = (value: string) => encryptBw(new TextEncoder().encode(value), enc, mac);

async function testFixture(ctx: TestContext, options: { failBlobDelete?: boolean } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  ctx.after(async () => {
    await new Promise((resolve) => setImmediate(resolve));
    sqlite.close();
  });

  sqlite.exec(`
    CREATE TABLE ciphers(id TEXT PRIMARY KEY, user_id TEXT, type INTEGER,
      folder_id TEXT, name TEXT, notes TEXT, favorite INTEGER, data TEXT,
      reprompt INTEGER, key TEXT, created_at TEXT, updated_at TEXT,
      archived_at TEXT, deleted_at TEXT);
    CREATE TABLE attachments(id TEXT PRIMARY KEY, cipher_id TEXT,
      file_name TEXT, size INTEGER, size_name TEXT, key TEXT);
    CREATE TABLE devices(user_id TEXT, push_token TEXT);
    CREATE TABLE user_revisions(user_id TEXT PRIMARY KEY, revision_date TEXT NOT NULL,
      revision_ms INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE folders(id TEXT PRIMARY KEY, user_id TEXT, name TEXT,
      created_at TEXT, updated_at TEXT);
    CREATE TABLE sends(id TEXT PRIMARY KEY, user_id TEXT, type INTEGER,
      name TEXT, notes TEXT, data TEXT, key TEXT, password_hash TEXT,
      password_salt TEXT, password_iterations INTEGER, auth_type INTEGER,
      emails TEXT, max_access_count INTEGER, access_count INTEGER,
      disabled INTEGER, hide_email INTEGER, created_at TEXT, updated_at TEXT,
      expiration_date TEXT, deletion_date TEXT);
    CREATE TABLE request_idempotency(user_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL, status INTEGER NOT NULL, response_body TEXT,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, idempotency_key));
    CREATE INDEX idx_request_idempotency_expires ON request_idempotency(expires_at);
    CREATE TABLE pending_attachment_cleanups(id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
      cipher_id TEXT NOT NULL, attachment_id TEXT NOT NULL, blob_key TEXT NOT NULL,
      retry_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, last_error TEXT);
    CREATE INDEX idx_pending_attachment_cleanups_created ON pending_attachment_cleanups(created_at);
  `);

  const execute = (sql: string, values: any[]) => {
    const statement = sqlite.prepare(sql);
    if (/^\s*(select|with|pragma)/i.test(sql)) {
      return { kind: 'rows' as const, rows: statement.all(...values) };
    }
    const result = statement.run(...values);
    return { kind: 'run' as const, changes: Number(result.changes) };
  };

  const db: any = {
    prepare(sql: string) {
      let values: any[] = [];
      const statement = {
        sql,
        get values() { return values; },
        bind(...bound: any[]) { values = bound; return statement; },
        async run() { return { success: true, meta: { changes: (execute(sql, values) as any).changes ?? 0 } }; },
        async all() { return { success: true, results: (execute(sql, values) as any).rows ?? [] }; },
        async first() { const out = execute(sql, values); return (out as any).rows?.[0] ?? null; },
      };
      return statement;
    },
    async batch(statements: any[]) {
      sqlite.exec('BEGIN');
      try {
        const results = statements.map((statement) => {
          const out = execute(statement.sql, statement.values);
          return out.kind === 'rows'
            ? { success: true, results: out.rows, meta: { changes: 0 } }
            : { success: true, results: [], meta: { changes: out.changes } };
        });
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };

  ctx.mock.method(StorageService.prototype, 'createAuditLog', async () => {});
  ctx.mock.method(StorageService.prototype, 'getConfigValue', async () => null);
  ctx.mock.method(StorageService.prototype, 'pruneAuditLogs', async () => {});

  const deletedBlobs: string[] = [];
  const notifications: any[] = [];
  let shouldFailBlobDelete = options.failBlobDelete ?? false;

  const env: any = {
    DB: db,
    JWT_SECRET: 'test-secret-with-at-least-32-characters-for-jwt-signing',
    ATTACHMENTS: {
      delete: async (key: string) => {
        if (shouldFailBlobDelete) {
          throw new Error('R2 simulated storage failure');
        }
        deletedBlobs.push(key);
      },
    },
    NOTIFICATIONS_HUB: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (_url: string, init: RequestInit) => {
          notifications.push(JSON.parse(init.body as string));
          return new Response(null, { status: 204 });
        },
      }),
    },
  };

  const storage = new StorageService(db);

  const route = async (path: string, method: string, body?: unknown, headers: Record<string, string> = {}) => {
    const request = new Request(`https://vault.example.test${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const response = await handleAuthenticatedRoute(request, env, owner, { id: owner } as any, path, method);
    assert.ok(response, `${method} ${path} must be handled`);
    return response;
  };

  return {
    storage,
    env,
    sqlite,
    route,
    deletedBlobs,
    notifications,
    setFailBlobDelete: (fail: boolean) => { shouldFailBlobDelete = fail; },
  };
}

test('D1-305: duplicate create cipher with same key and body returns stored response without duplicate creation', async (ctx) => {
  const f = await testFixture(ctx);
  const idempotencyKey = 'key-cipher-1';
  const payload = {
    type: 1,
    name: await encrypt('Item Title'),
    notes: await encrypt('Notes'),
    login: { username: await encrypt('Username'), password: await encrypt('Password') },
  };

  const resp1 = await f.route('/api/ciphers', 'POST', payload, { 'Idempotency-Key': idempotencyKey });
  assert.equal(resp1.status, 200);
  const body1: any = await resp1.json();
  assert.ok(body1.id, 'Cipher ID is present');
  assert.equal(f.notifications.length, 2, 'Sync notifications sent on creation (SyncVault + SyncCipherCreate)');

  // Verify record in request_idempotency
  const row = f.sqlite.prepare('SELECT user_id, idempotency_key, status FROM request_idempotency WHERE idempotency_key = ?').get(idempotencyKey) as any;
  assert.ok(row, 'Idempotency record stored');
  assert.equal(row.status, 200);

  // Second request with exact same key and payload
  const resp2 = await f.route('/api/ciphers', 'POST', payload, { 'Idempotency-Key': idempotencyKey });
  assert.equal(resp2.status, 200);
  assert.equal(resp2.headers.get('Idempotent-Replay'), 'true', 'Replay header is set');
  const body2: any = await resp2.json();
  assert.equal(body2.id, body1.id, 'Same item ID is returned');
  assert.equal(f.notifications.length, 2, 'Sync notifications are NOT sent again on idempotent replay');

  // Verify only 1 cipher was created in the database
  const countRow = f.sqlite.prepare('SELECT count(*) as count FROM ciphers').get() as any;
  assert.equal(countRow.count, 1, 'Only one cipher exists in database');
});

test('D1-305: create cipher with same key but different body returns 409 conflict', async (ctx) => {
  const f = await testFixture(ctx);
  const idempotencyKey = 'key-cipher-conflict';
  const payload1 = {
    type: 1,
    name: await encrypt('Original Title'),
  };
  const payload2 = {
    type: 1,
    name: await encrypt('Different Title'),
  };

  const resp1 = await f.route('/api/ciphers', 'POST', payload1, { 'Idempotency-Key': idempotencyKey });
  assert.equal(resp1.status, 200);

  const resp2 = await f.route('/api/ciphers', 'POST', payload2, { 'Idempotency-Key': idempotencyKey });
  assert.equal(resp2.status, 409, 'Conflict status returned for mismatched body');
});

test('D1-305: folder creation respects idempotency key', async (ctx) => {
  const f = await testFixture(ctx);
  const idempotencyKey = 'key-folder-1';
  const payload = { name: await encrypt('Work Folder') };

  const resp1 = await f.route('/api/folders', 'POST', payload, { 'Idempotency-Key': idempotencyKey });
  assert.equal(resp1.status, 200);
  const body1: any = await resp1.json();
  assert.ok(body1.id, 'Folder ID is present');

  const resp2 = await f.route('/api/folders', 'POST', payload, { 'Idempotency-Key': idempotencyKey });
  assert.equal(resp2.status, 200);
  assert.equal(resp2.headers.get('Idempotent-Replay'), 'true');
  const body2: any = await resp2.json();
  assert.equal(body2.id, body1.id, 'Same folder ID returned');

  const countRow = f.sqlite.prepare('SELECT count(*) as count FROM folders').get() as any;
  assert.equal(countRow.count, 1, 'Only one folder exists in database');

  // Different payload returns 409
  const resp3 = await f.route('/api/folders', 'POST', { name: await encrypt('Other Name') }, { 'Idempotency-Key': idempotencyKey });
  assert.equal(resp3.status, 409);
});

test('D1-305: send creation respects idempotency key', async (ctx) => {
  const f = await testFixture(ctx);
  const idempotencyKey = 'key-send-1';
  const payload = {
    type: 0,
    name: await encrypt('Send Name'),
    key: 'dummy-send-key',
    deletionDate: new Date(Date.now() + 7 * 86400000).toISOString(),
    text: { text: await encrypt('Secret message') },
  };

  const resp1 = await f.route('/api/sends', 'POST', payload, { 'Idempotency-Key': idempotencyKey });
  assert.equal(resp1.status, 200);
  const body1: any = await resp1.json();
  assert.ok(body1.id, 'Send ID is present');

  const resp2 = await f.route('/api/sends', 'POST', payload, { 'Idempotency-Key': idempotencyKey });
  assert.equal(resp2.status, 200);
  assert.equal(resp2.headers.get('Idempotent-Replay'), 'true');
  const body2: any = await resp2.json();
  assert.equal(body2.id, body1.id, 'Same send ID returned');

  const countRow = f.sqlite.prepare('SELECT count(*) as count FROM sends').get() as any;
  assert.equal(countRow.count, 1, 'Only one send exists in database');
});

test('D1-305: file send v2 creation respects idempotency key', async (ctx) => {
  const f = await testFixture(ctx);
  const idempotencyKey = 'key-file-send-1';
  const payload = {
    type: 1,
    name: await encrypt('Document Send'),
    key: 'dummy-file-send-key',
    fileLength: 2048,
    file: { fileName: await encrypt('report.pdf') },
    deletionDate: new Date(Date.now() + 7 * 86400000).toISOString(),
  };

  const resp1 = await f.route('/api/sends/file/v2', 'POST', payload, { 'Idempotency-Key': idempotencyKey });
  assert.equal(resp1.status, 200);
  const body1: any = await resp1.json();
  assert.ok(body1.url, 'Upload URL is present in v2 file send response');
  assert.ok(body1.sendResponse?.id, 'Send ID is present');

  const resp2 = await f.route('/api/sends/file/v2', 'POST', payload, { 'Idempotency-Key': idempotencyKey });
  assert.equal(resp2.status, 200);
  assert.equal(resp2.headers.get('Idempotent-Replay'), 'true');
  const body2: any = await resp2.json();
  assert.equal(body2.sendResponse.id, body1.sendResponse.id, 'Same send ID returned on replay');
  assert.equal(body2.url, body1.url, 'Same upload url returned on replay');

  const countRow = f.sqlite.prepare('SELECT count(*) as count FROM sends').get() as any;
  assert.equal(countRow.count, 1, 'Only one send exists in database');
});

test('D1-305: expired idempotency record allows key reuse and pruning deletes only expired rows', async (ctx) => {
  const f = await testFixture(ctx);
  const idempotencyKey = 'key-expired-test';

  // Insert an expired record
  f.sqlite.prepare(`
    INSERT INTO request_idempotency(user_id, idempotency_key, request_hash, status, response_body, created_at, expires_at)
    VALUES(?, ?, 'old-hash', 200, '{"id":"old"}', ?, ?)
  `).run(owner, idempotencyKey, Date.now() - 10000, Date.now() - 5000);

  // An expired record returns null on getIdempotencyRecord
  const lookup = await f.storage.getIdempotencyRecord(owner, idempotencyKey);
  assert.equal(lookup, null, 'Expired record is treated as null');

  // Insert a valid unexpired record
  f.sqlite.prepare(`
    INSERT INTO request_idempotency(user_id, idempotency_key, request_hash, status, response_body, created_at, expires_at)
    VALUES(?, 'valid-key', 'valid-hash', 200, '{"id":"valid"}', ?, ?)
  `).run(owner, Date.now(), Date.now() + 3600000);

  // Prune expired records
  const pruned = await pruneExpiredIdempotency(f.env.DB, Date.now());
  assert.equal(pruned, 1, 'Exactly one expired record was pruned');

  const remaining = f.sqlite.prepare('SELECT idempotency_key FROM request_idempotency').all() as any[];
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].idempotency_key, 'valid-key');
});

test('D1-304: permanent delete with R2 deletion failure records cleanup task and returns pending status', async (ctx) => {
  const f = await testFixture(ctx, { failBlobDelete: true });
  const cipherId = '00000000-0000-4000-8000-0000000000aa';
  const attachId = '00000000-0000-4000-8000-0000000000ab';
  const now = new Date().toISOString();

  // Create cipher and attachment
  await f.storage.saveCipher({
    id: cipherId,
    userId: owner,
    type: 1,
    name: await encrypt('Secret'),
    favorite: false,
    notes: null,
    folderId: null,
    key: null,
    login: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: now,
  });
  await f.storage.saveAttachment({
    id: attachId,
    cipherId,
    fileName: await encrypt('file.pdf'),
    size: 1024,
    sizeName: '1 KB',
    key: null,
  });

  // Perform permanent delete
  const response = await f.route(`/api/ciphers/${cipherId}/delete`, 'DELETE');
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('X-Attachment-Cleanup'), 'pending', 'Pending cleanup header is returned');

  // Cipher and attachment rows are gone from D1
  assert.equal(await f.storage.getCipherForUser(cipherId, owner), null, 'Cipher is deleted from D1');
  assert.equal(await f.storage.getAttachment(attachId), null, 'Attachment metadata is deleted from D1');

  // But the blob deletion failed, so it was recorded in pending_attachment_cleanups
  const cleanupTasks = await f.storage.getPendingAttachmentCleanups();
  assert.equal(cleanupTasks.length, 1, 'Cleanup task was recorded');
  assert.equal(cleanupTasks[0].cipherId, cipherId);
  assert.equal(cleanupTasks[0].attachmentId, attachId);
  assert.ok(cleanupTasks[0].blobKey.includes(cipherId));

  // Now simulate R2 recovering and running scheduled cleanup
  f.setFailBlobDelete(false);
  const result = await f.storage.processPendingAttachmentCleanups(f.env);
  assert.equal(result.processed, 1);
  assert.equal(result.succeeded, 1);
  assert.equal(f.deletedBlobs.length, 1, 'Blob was successfully deleted by compensation runner');

  // The cleanup task table is now empty
  const remainingTasks = await f.storage.getPendingAttachmentCleanups();
  assert.equal(remainingTasks.length, 0, 'Pending cleanup task was completed and removed');
});

test('D1-304: folder delete cleans references and folder atomically in batch', async (ctx) => {
  const f = await testFixture(ctx);
  const folderId = '00000000-0000-4000-8000-0000000000bb';
  const cipherId = '00000000-0000-4000-8000-0000000000bc';
  const now = new Date().toISOString();

  await f.storage.saveFolder({
    id: folderId,
    userId: owner,
    name: await encrypt('Test Folder'),
    createdAt: now,
    updatedAt: now,
  });

  await f.storage.saveCipher({
    id: cipherId,
    userId: owner,
    type: 1,
    name: await encrypt('Item'),
    favorite: false,
    notes: null,
    folderId,
    key: null,
    login: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  });

  // Delete folder
  const response = await f.route(`/api/folders/${folderId}`, 'DELETE');
  assert.equal(response.status, 204);

  // Folder is deleted and cipher reference is cleared
  assert.equal(await f.storage.getFolderForUser(folderId, owner), null);
  const cipher = await f.storage.getCipherForUser(cipherId, owner);
  assert.equal(cipher?.folderId, null);
});
