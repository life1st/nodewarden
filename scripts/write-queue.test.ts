import assert from 'node:assert/strict';
import test from 'node:test';

import {
  enqueueWrite,
  getWriteState,
  subscribeWriteState,
} from '../webapp/src/lib/api/write-queue';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('writes of one key run strictly one after another', async () => {
  const key = 'test-serial';
  let active = 0;
  let maxActive = 0;
  const order: string[] = [];
  const job = (id: string, ms: number) => async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    order.push(`start:${id}`);
    await delay(ms);
    order.push(`end:${id}`);
    active -= 1;
  };

  const first = enqueueWrite(key, { kind: 'save', cipherId: 'a' }, job('1', 30));
  const second = enqueueWrite(key, { kind: 'save', cipherId: 'b' }, job('2', 5));
  await Promise.all([first, second]);

  assert.equal(maxActive, 1);
  assert.deepEqual(order, ['start:1', 'end:1', 'start:2', 'end:2']);
  assert.equal(getWriteState(key).pending, 0);
});

test('a failed job does not block the next job', async () => {
  const key = 'test-failure';
  const failing = enqueueWrite(key, { kind: 'save', cipherId: 'a' }, async () => {
    throw new Error('boom');
  });
  const following = enqueueWrite(key, { kind: 'save', cipherId: 'b' }, async () => 'ok');

  await assert.rejects(failing, /boom/);
  assert.equal(await following, 'ok');
  assert.equal(getWriteState(key).pending, 0);
  assert.equal(getWriteState(key).running, false);
});

test('state notifications cover queued -> running -> idle', async () => {
  const key = 'test-state';
  const phases: string[] = [];
  const unsubscribe = subscribeWriteState(key, () => {
    const state = getWriteState(key);
    phases.push(`${state.current?.phase || 'idle'}:${state.queued.length}`);
  });

  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = enqueueWrite(key, { kind: 'save', cipherId: 'a' }, () => gate);
  const second = enqueueWrite(key, { kind: 'archive', cipherId: 'b' }, async () => {});
  await delay(5);

  const mid = getWriteState(key);
  assert.equal(mid.running, true);
  assert.equal(mid.pending, 2);
  assert.equal(mid.current?.phase, 'running');
  assert.equal(mid.current?.cipherId, 'a');
  assert.equal(mid.queued.length, 1);
  assert.equal(mid.queued[0].phase, 'queued');
  assert.equal(mid.queued[0].cipherId, 'b');

  release();
  await Promise.all([first, second]);

  const done = getWriteState(key);
  assert.equal(done.pending, 0);
  assert.equal(done.running, false);
  assert.equal(done.current, null);
  assert.ok(phases.includes('running:1'), `expected running phase, got ${phases.join(',')}`);
  assert.equal(phases[phases.length - 1], 'idle:0');
  unsubscribe();
});

test('duplicate submissions with the same dedupe key join the pending job', async () => {
  const key = 'test-dedupe';
  let calls = 0;
  const job = async () => {
    calls += 1;
    await delay(10);
    return calls;
  };

  const first = enqueueWrite(key, { kind: 'save', cipherId: 'x', dedupeKey: 'save:x' }, job);
  const second = enqueueWrite(key, { kind: 'save', cipherId: 'x', dedupeKey: 'save:x' }, job);
  assert.equal(first, second);
  assert.equal(await first, 1);
  assert.equal(await second, 1);
  assert.equal(calls, 1);

  const third = enqueueWrite(key, { kind: 'save', cipherId: 'x', dedupeKey: 'save:x' }, job);
  assert.equal(await third, 2);
  assert.equal(calls, 2);
});

test('different keys do not wait for each other', async () => {
  const keyA = 'test-key-a';
  const keyB = 'test-key-b';
  let active = 0;
  let maxActive = 0;
  const job = async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await delay(20);
    active -= 1;
  };

  await Promise.all([
    enqueueWrite(keyA, { kind: 'save' }, job),
    enqueueWrite(keyB, { kind: 'send' }, job),
  ]);
  assert.equal(maxActive, 2);
});
