import { uuid as createRequestId } from '../utils/uuid';
type Intent = { requestId: string; state: 'pending' | 'resolved' };
const prefix = 'ca:tournament-unregister:v1:';
const running = new Map<string, Promise<unknown>>();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function read(raw: string | null): Intent | null {
  if (raw === null) return null;
  const value = JSON.parse(raw) as Intent;
  if (!value || !uuid.test(value.requestId) || !['pending', 'resolved'].includes(value.state))
    throw new Error('The Saved Tournament Transaction Request Could Not Be Verified.');
  return value;
}

/** Retain the original refund request until its matching server receipt is confirmed. */
export function withTournamentUnregistrationIntent<T>(
  userId: string,
  tournamentId: string,
  submit: (requestId: string) => Promise<T>
): Promise<T> {
  const key = prefix + userId + ':' + tournamentId;
  const active = running.get(key);
  if (active) return active as Promise<T>;
  const work = (async () => {
    if (!globalThis.navigator?.locks || !globalThis.crypto?.randomUUID)
      throw new Error('This Browser Cannot Safely Save The Tournament Transaction Request.');
    const storage = globalThis.localStorage;
    const session = globalThis.sessionStorage;
    const invokedRaw = storage.getItem(key);
    return navigator.locks.request(key, async () => {
      const currentRaw = storage.getItem(key);
      const current = read(currentRaw);
      const own = read(session.getItem(key));
      const invoked = read(invokedRaw);
      const original =
        own?.state === 'pending'
          ? own
          : invoked?.state === 'pending'
            ? invoked
            : current?.state === 'pending'
              ? current
              : currentRaw !== invokedRaw
                ? current
                : null;
      const intent: Intent = {
        requestId: original?.requestId ?? createRequestId(),
        state: 'pending',
      };
      const raw = JSON.stringify(intent);
      session.setItem(key, raw);
      if (session.getItem(key) !== raw)
        throw new Error('The Tournament Transaction Request Could Not Be Saved.');
      if (!current || !original || current.requestId === intent.requestId) {
        storage.setItem(key, raw);
        if (storage.getItem(key) !== raw)
          throw new Error('The Tournament Transaction Request Could Not Be Saved.');
      }
      const result = await submit(intent.requestId);
      try {
        const resolved = JSON.stringify({ ...intent, state: 'resolved' });
        session.setItem(key, resolved);
        if (read(storage.getItem(key))?.requestId === intent.requestId)
          storage.setItem(key, resolved);
      } catch {
        // A confirmed refund remains confirmed; retained identity safely replays it.
      }
      return result;
    });
  })();
  running.set(key, work);
  const cleanup = () => {
    if (running.get(key) === work) running.delete(key);
  };
  void work.then(cleanup, cleanup);
  return work;
}
