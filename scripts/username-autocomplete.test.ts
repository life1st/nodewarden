import assert from 'node:assert/strict';
import test from 'node:test';

import { buildLoginUsernameIndex, findUsernameCompletion } from '../webapp/src/lib/username-autocomplete';

function cipher(overrides: Record<string, unknown>): any {
  return {
    id: String(overrides.id || 'cipher'),
    type: 1,
    name: '',
    login: {},
    ...overrides,
  };
}

test('buildLoginUsernameIndex extracts unique visible login usernames', () => {
  const usernames = buildLoginUsernameIndex([
    cipher({ id: '1', login: { decUsername: 'aabb@gmail.com' } }),
    cipher({ id: '2', login: { username: 'fallback@example.com' } }),
    cipher({ id: '3', login: { decUsername: 'AABB@gmail.com' } }),
    cipher({ id: '4', type: 2, login: { decUsername: 'ignored@example.com' } }),
    cipher({ id: '5', login: { decUsername: '   ' } }),
    cipher({ id: '6', login: { decUsername: 'deleted@example.com' }, deletedDate: '2026-01-01' }),
    cipher({ id: '7', login: { decUsername: 'archived@example.com' }, archivedAt: '2026-01-01' }),
    cipher({ id: '8', login: { decUsername: 'aabbccd@qq.com' } }),
  ]);

  assert.deepEqual(usernames, ['aabb@gmail.com', 'fallback@example.com', 'aabbccd@qq.com']);
});

test('findUsernameCompletion returns the first prefix match without changing case', () => {
  const usernames = ['aabb@gmail.com', 'aabbccd@qq.com'];

  assert.equal(findUsernameCompletion('a', usernames), 'aabb@gmail.com');
  assert.equal(findUsernameCompletion('A', usernames), 'aabb@gmail.com');
  assert.equal(findUsernameCompletion('aabbcc', usernames), 'aabbccd@qq.com');
  assert.equal(findUsernameCompletion('x', usernames), null);
  assert.equal(findUsernameCompletion('', usernames), null);
  assert.equal(findUsernameCompletion('   ', usernames), null);
  assert.equal(findUsernameCompletion('aabb@gmail.com', usernames), null);
  assert.equal(findUsernameCompletion('aabb@gmail.comx', usernames), null);
});
