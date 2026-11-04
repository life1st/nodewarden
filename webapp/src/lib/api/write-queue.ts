export type MutationKind =
  | 'save'
  | 'delete'
  | 'archive'
  | 'unarchive'
  | 'restore'
  | 'move'
  | 'folder'
  | 'send'
  | 'import'
  | 'other';

export type MutationPhase = 'queued' | 'running';

export interface MutationState {
  id: string;
  kind: MutationKind;
  cipherId?: string;
  folderId?: string;
  phase: MutationPhase;
}

export interface WriteJobMeta {
  kind: MutationKind;
  cipherId?: string;
  folderId?: string;
  /**
   * Optional de-duplication key. When a waiting or running job already carries
   * the same key, the new caller joins that job instead of submitting the
   * write a second time (e.g. double-clicking save on the same item).
   */
  dedupeKey?: string;
}

export interface WriteQueueSnapshot {
  pending: number;
  running: boolean;
  current: MutationState | null;
  queued: MutationState[];
}

/** All vault writes of this tab share one queue so D1 only sees one at a time. */
export const VAULT_WRITE_KEY = 'vault';
/** Send writes get their own queue; they never run in parallel within the key. */
export const SEND_WRITE_KEY = 'send';
/** Placeholder target id for "create new item" write jobs. */
export const NEW_CIPHER_WRITE_TARGET = '__new_cipher__';

interface QueueEntry {
  state: MutationState;
  dedupeKey?: string;
  promise: Promise<unknown>;
  job: () => Promise<void>;
}

interface WriteQueue {
  waiting: QueueEntry[];
  current: QueueEntry | null;
  draining: boolean;
}

const queues = new Map<string, WriteQueue>();
const listeners = new Map<string, Set<() => void>>();
let sequence = 0;

function getQueue(key: string): WriteQueue {
  let queue = queues.get(key);
  if (!queue) {
    queue = { waiting: [], current: null, draining: false };
    queues.set(key, queue);
  }
  return queue;
}

function notify(key: string): void {
  const set = listeners.get(key);
  if (!set) return;
  for (const listener of Array.from(set)) listener();
}

function findDedupedEntry(queue: WriteQueue, dedupeKey: string): QueueEntry | null {
  if (queue.current?.dedupeKey === dedupeKey) return queue.current;
  return queue.waiting.find((entry) => entry.dedupeKey === dedupeKey) || null;
}

function drain(key: string): void {
  const queue = getQueue(key);
  if (queue.draining) return;
  queue.draining = true;
  void (async () => {
    try {
      while (queue.waiting.length) {
        const entry = queue.waiting.shift()!;
        queue.current = entry;
        entry.state = { ...entry.state, phase: 'running' };
        notify(key);
        try {
          await entry.job();
        } finally {
          // A failed job must never keep the queue stuck: clear it here so the
          // next job starts and subscribers observe the transition.
          queue.current = null;
          notify(key);
        }
      }
    } finally {
      queue.draining = false;
    }
  })();
}

/**
 * Runs `job` after every write already queued under `key`. Jobs of one key
 * never overlap; a rejection is forwarded to the caller and does not block
 * later jobs. No automatic retry happens here.
 */
export function enqueueWrite<T>(key: string, meta: WriteJobMeta, job: () => Promise<T>): Promise<T> {
  const queue = getQueue(key);
  if (meta.dedupeKey) {
    const existing = findDedupedEntry(queue, meta.dedupeKey);
    if (existing) return existing.promise as Promise<T>;
  }

  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  const entry: QueueEntry = {
    state: {
      id: `write-${++sequence}`,
      kind: meta.kind,
      cipherId: meta.cipherId,
      folderId: meta.folderId,
      phase: 'queued',
    },
    dedupeKey: meta.dedupeKey,
    promise,
    job: async () => {
      try {
        resolve(await job());
      } catch (error) {
        reject(error);
      }
    },
  };

  queue.waiting.push(entry);
  notify(key);
  drain(key);
  return promise;
}

export function getWriteState(key: string): WriteQueueSnapshot {
  const queue = queues.get(key);
  if (!queue) return { pending: 0, running: false, current: null, queued: [] };
  return {
    pending: queue.waiting.length + (queue.current ? 1 : 0),
    running: !!queue.current,
    current: queue.current ? queue.current.state : null,
    queued: queue.waiting.map((entry) => entry.state),
  };
}

export function subscribeWriteState(key: string, listener: () => void): () => void {
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(listener);
  return () => {
    const current = listeners.get(key);
    if (!current) return;
    current.delete(listener);
    if (!current.size) listeners.delete(key);
  };
}
