import assert from 'node:assert/strict';
import test from 'node:test';

// Browser globals required by auth.ts / i18n.ts when running under Node.
const storage = new Map<string, string>();
(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => {
    storage.set(key, String(value));
  },
  removeItem: (key: string) => {
    storage.delete(key);
  },
};
(globalThis as unknown as { window: unknown }).window = {
  setTimeout,
  clearTimeout,
};

const { createAuthedFetch, isRetryableMethod } = await import('../webapp/src/lib/api/auth.ts');

type FetchCall = { url: string; method: string };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stubFetch(handler: (call: FetchCall, index: number) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const call = {
      url: String(input),
      method: (init.method || 'GET').toUpperCase(),
    };
    const index = calls.length;
    calls.push(call);
    return handler(call, index);
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function makeAuthedFetch() {
  let session = {
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    email: 'user@example.test',
    authMode: 'token' as const,
  };
  return createAuthedFetch(
    () => session,
    (next) => {
      session = next as typeof session;
    }
  );
}

test('isRetryableMethod only allows GET/HEAD/OPTIONS', () => {
  assert.equal(isRetryableMethod(undefined), true);
  assert.equal(isRetryableMethod('GET'), true);
  assert.equal(isRetryableMethod('get'), true);
  assert.equal(isRetryableMethod('HEAD'), true);
  assert.equal(isRetryableMethod('OPTIONS'), true);
  assert.equal(isRetryableMethod('POST'), false);
  assert.equal(isRetryableMethod('PUT'), false);
  assert.equal(isRetryableMethod('PATCH'), false);
  assert.equal(isRetryableMethod('DELETE'), false);
});

test('POST hitting 500 is only sent once', async () => {
  const stub = stubFetch(() => json({ error: 'boom' }, 500));
  try {
    const authedFetch = makeAuthedFetch();
    const resp = await authedFetch('/api/ciphers', {
      method: 'POST',
      body: JSON.stringify({ name: 'a' }),
    });
    assert.equal(resp.status, 500);
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].method, 'POST');
  } finally {
    stub.restore();
  }
});

test('PUT hitting 500 is only sent once', async () => {
  const stub = stubFetch(() => json({ error: 'boom' }, 500));
  try {
    const authedFetch = makeAuthedFetch();
    const resp = await authedFetch('/api/ciphers/abc', {
      method: 'PUT',
      body: JSON.stringify({ name: 'b' }),
    });
    assert.equal(resp.status, 500);
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].method, 'PUT');
  } finally {
    stub.restore();
  }
});

test('DELETE hitting a network error is not retried', async () => {
  const stub = stubFetch(() => {
    throw new TypeError('network down');
  });
  try {
    const authedFetch = makeAuthedFetch();
    await assert.rejects(() => authedFetch('/api/ciphers/abc', { method: 'DELETE' }));
    assert.equal(stub.calls.length, 1);
  } finally {
    stub.restore();
  }
});

test('GET hitting 500 keeps the existing 3-attempt retry policy', async () => {
  const stub = stubFetch(() => json({ error: 'boom' }, 500));
  try {
    const authedFetch = makeAuthedFetch();
    const resp = await authedFetch('/api/ciphers');
    assert.equal(resp.status, 500);
    assert.equal(stub.calls.length, 3);
  } finally {
    stub.restore();
  }
});

test('write request retries exactly once after a 401 token refresh', async () => {
  const stub = stubFetch((call, index) => {
    if (call.url === '/identity/connect/token') {
      return json({ access_token: 'access-2', refresh_token: 'refresh-2' });
    }
    // First API attempt: stale token -> 401. Second attempt (post refresh): success.
    return index === 0 ? json({ error: 'unauthorized' }, 401) : json({ id: 'cipher-1' });
  });
  try {
    const authedFetch = makeAuthedFetch();
    const resp = await authedFetch('/api/ciphers/abc', {
      method: 'PUT',
      body: JSON.stringify({ name: 'c' }),
    });
    assert.equal(resp.status, 200);
    const apiCalls = stub.calls.filter((call) => call.url !== '/identity/connect/token');
    assert.equal(apiCalls.length, 2);
    assert.ok(stub.calls.some((call) => call.url === '/identity/connect/token'));
  } finally {
    stub.restore();
  }
});
