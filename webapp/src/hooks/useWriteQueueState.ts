import { useEffect, useState } from 'preact/hooks';
import { getWriteState, subscribeWriteState, type WriteQueueSnapshot } from '@/lib/api/write-queue';

export default function useWriteQueueState(key: string): WriteQueueSnapshot {
  const [snapshot, setSnapshot] = useState<WriteQueueSnapshot>(() => getWriteState(key));
  useEffect(() => subscribeWriteState(key, () => setSnapshot(getWriteState(key))), [key]);
  return snapshot;
}
