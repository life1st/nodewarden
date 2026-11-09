import assert from 'node:assert/strict';
import test from 'node:test';
import { handleRequest } from '../src/router';
import {
  getD1ErrorCode,
  getD1RetryAfterSeconds,
  isD1TransientError,
} from '../src/utils/d1-errors';
import {
  createRequestObservabilityContext,
  getOperationName,
  wrapD1Database,
} from '../src/utils/observability';
import { apiErrorFromResponse } from '../webapp/src/lib/api/shared';

function errorWith(message: string): Error {
  return new Error(message);
}

function overloadedEnv(): any {
  return {
    JWT_SECRET: 'test-secret-that-is-long-enough-for-the-check',
    DB: {
      prepare() {
        throw errorWith('D1_ERROR: The database is overloaded.');
      },
    },
  };
}

function unknownFailureEnv(): any {
  return {
    JWT_SECRET: 'test-secret-that-is-long-enough-for-the-check',
    DB: {
      prepare() {
        throw errorWith('unexpected boom');
      },
    },
  };
}

test('D1 transient error classification recognises retryable failures', () => {
  for (const message of [
    'D1_ERROR: The database is overloaded.',
    'D1_ERROR: Network connection lost.',
    'D1_ERROR: storage operation exceeded timeout.',
    'Error: database is locked',
    'Durable Object was reset because its code was updated.',
    'Could not resolve D1 database binding DB',
  ]) {
    assert.equal(isD1TransientError(new Error(message)), true, message);
    assert.ok(getD1ErrorCode(new Error(message)));
  }

  for (const message of [
    'D1_ERROR: no such table: ciphers',
    'D1_ERROR: UNIQUE constraint failed: ciphers.id',
    'Invalid request payload',
  ]) {
    assert.equal(isD1TransientError(new Error(message)), false, message);
    assert.equal(getD1ErrorCode(new Error(message)), null, message);
  }
});

test('D1 retry delays are bounded per error class', () => {
  assert.equal(getD1RetryAfterSeconds(new Error('D1_ERROR: overloaded')), 2);
  assert.equal(getD1RetryAfterSeconds(new Error('D1_ERROR: Network connection lost')), 1);
  assert.equal(getD1RetryAfterSeconds(new Error('D1_ERROR: storage operation exceeded timeout')), 3);
});

test('operation names map the main vault write paths', () => {
  assert.equal(getOperationName('PUT', '/api/ciphers/abc'), 'cipher.update');
  assert.equal(getOperationName('POST', '/api/ciphers'), 'cipher.create');
  assert.equal(getOperationName('DELETE', '/api/ciphers/abc'), 'cipher.delete');
  assert.equal(getOperationName('POST', '/api/ciphers/delete'), 'cipher.deleteBulk');
  assert.equal(getOperationName('PUT', '/api/folders/abc'), 'folder.update');
  assert.equal(getOperationName('POST', '/api/sends'), 'send.create');
  assert.equal(getOperationName('GET', '/api/sync'), 'vault.sync');
});

test('observed D1 wrapper counts calls and durations without binding values', async () => {
  const ctx = createRequestObservabilityContext(
    new Request('https://vault.example.test/api/ciphers/abc', { method: 'PUT' })
  );
  const calls: string[] = [];
  const statement = {
    bind(...values: unknown[]) {
      calls.push(`bind:${values.join(',')}`);
      return statement;
    },
    async run() {
      calls.push('run');
      return { success: true, meta: { changes: 1 } };
    },
    async all() {
      calls.push('all');
      return { success: true, results: [] };
    },
    async first() {
      calls.push('first');
      return null;
    },
  };
  const db: any = {
    prepare(query: string) {
      calls.push(`prepare:${query}`);
      return statement;
    },
    async batch(statements: unknown[]) {
      calls.push(`batch:${statements.length}`);
      return [];
    },
  };

  const observed = wrapD1Database(db, ctx);
  await (observed.prepare('UPDATE ciphers SET name = ? WHERE id = ?').bind('secret-name', 'abc') as any).run();
  await observed.batch([db.prepare('UPDATE ciphers SET name = ? WHERE id = ?'), db.prepare('DELETE FROM ciphers')]);

  assert.equal(ctx.d1Calls, 2);
  assert.ok(ctx.d1DurationMs >= 0);
  assert.equal(ctx.d1CallDetails.length, 2);
  assert.equal(ctx.d1CallDetails[0].op, 'run');
  assert.equal(ctx.d1CallDetails[1].op, 'batch');
  assert.match(ctx.d1CallDetails[0].sql, /^UPDATE ciphers SET name = \? WHERE id = \?$/);
  assert.doesNotMatch(JSON.stringify(ctx.d1CallDetails), /secret-name/);
});

test('D1 overloaded errors become 503 with Retry-After and an error code', async (ctx) => {
  ctx.mock.method(console, 'log', () => {});
  ctx.mock.method(console, 'error', () => {});

  const request = new Request('https://vault.example.test/identity/accounts/prelogin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.10' },
    body: JSON.stringify({ email: 'user@example.com' }),
  });
  const response = await handleRequest(request, overloadedEnv());
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('Retry-After'), '2');
  assert.ok(response.headers.get('X-Request-Id'));
  const body: any = await response.json();
  assert.equal(body.code, 'D1_OVERLOADED');
});

test('unknown errors still return 500', async (ctx) => {
  ctx.mock.method(console, 'log', () => {});
  ctx.mock.method(console, 'error', () => {});

  const request = new Request('https://vault.example.test/identity/accounts/prelogin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.10' },
    body: JSON.stringify({ email: 'user@example.com' }),
  });
  const response = await handleRequest(request, unknownFailureEnv());
  assert.equal(response.status, 500);
  assert.equal(response.headers.get('Retry-After'), null);
  const body: any = await response.json();
  assert.equal(body.code, 'INTERNAL_ERROR');
});

test('frontend API errors keep status, code and Retry-After for 503/409/500', async () => {
  const busy = await apiErrorFromResponse(
    new Response(JSON.stringify({ error: 'Service temporarily unavailable', code: 'D1_OVERLOADED' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json', 'Retry-After': '4' },
    }),
    'fallback'
  );
  assert.equal(busy.status, 503);
  assert.equal(busy.code, 'D1_OVERLOADED');
  assert.equal(busy.retryAfterMs, 4000);

  const conflict = await apiErrorFromResponse(
    new Response(
      JSON.stringify({ error: 'The client copy of this cipher is out of date. Resync the client and try again.' }),
      { status: 409, headers: { 'Content-Type': 'application/json' } }
    ),
    'fallback'
  );
  assert.equal(conflict.status, 409);
  assert.match(conflict.message, /changed in another client/i);

  const failure = await apiErrorFromResponse(
    new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    }),
    'fallback'
  );
  assert.equal(failure.status, 500);
  assert.notEqual(failure.message, conflict.message);
});
