import { uuid } from '../utils/uuid';

export type TournamentUnregisterIntent = {
  kind: 'tournament' | 'seat';
  userId: string;
  targetId: string;
};

export type TournamentUnregisterAttempt = {
  version: 1;
  requestId: string;
  intent: TournamentUnregisterIntent;
};

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface TournamentUnregisterJournalEnvironment {
  local?: StorageLike;
  session?: StorageLike;
  lock: <T>(key: string, work: () => T) => Promise<T>;
  createId: () => string;
}

const PREFIX = 'smarter-poker:tournament-unregister-pending:v1:';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalized(intent: TournamentUnregisterIntent): TournamentUnregisterIntent {
  return {
    kind: intent.kind,
    userId: intent.userId.toLowerCase(),
    targetId: intent.targetId.toLowerCase(),
  };
}

function keyFor(intent: TournamentUnregisterIntent): string {
  const value = normalized(intent);
  return `${PREFIX}${value.kind}:${value.userId}:${value.targetId}`;
}

function sameIntent(a: TournamentUnregisterIntent, b: TournamentUnregisterIntent): boolean {
  const left = normalized(a);
  const right = normalized(b);
  return (
    left.kind === right.kind && left.userId === right.userId && left.targetId === right.targetId
  );
}

function decode(raw: string, expected: TournamentUnregisterIntent): TournamentUnregisterAttempt {
  const value = JSON.parse(raw) as TournamentUnregisterAttempt;
  if (
    value?.version !== 1 ||
    !UUID.test(value.requestId) ||
    !value.intent ||
    !sameIntent(value.intent, expected)
  ) {
    throw new Error('The Saved Tournament Exit Could Not Be Verified');
  }
  return value;
}

/**
 * IndexedDB read/write transactions serialize this tiny storage critical
 * section across tabs. Network I/O is deliberately outside the lock.
 */
export function lockTournamentUnregisterJournal<T>(
  work: () => T,
  factory: IDBFactory | undefined = globalThis.indexedDB
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (!factory) {
      reject(new Error('Tournament Exit Recovery Storage Is Unavailable'));
      return;
    }

    let settled = false;
    let db: IDBDatabase | undefined;
    let transaction: IDBTransaction | undefined;
    let result: T;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      db?.close();
      if (error) reject(error);
      else resolve(result!);
    };
    const timer = setTimeout(() => {
      finish(new Error('Tournament Exit Recovery Storage Timed Out'));
      try {
        transaction?.abort();
      } catch {
        // The transaction may already have completed while the timeout fired.
      }
    }, 2_000);

    try {
      const request = factory.open('ca-tournament-unregister-journal-lock', 1);
      request.onupgradeneeded = () => {
        if (settled) {
          request.transaction?.abort();
          return;
        }
        request.result.createObjectStore('journal');
      };
      request.onerror = () =>
        finish(request.error ?? new Error('Tournament Exit Recovery Storage Failed'));
      request.onsuccess = () => {
        db = request.result;
        if (settled) {
          db.close();
          return;
        }
        try {
          transaction = db.transaction('journal', 'readwrite');
          transaction.oncomplete = () => finish();
          transaction.onabort = () =>
            finish(transaction?.error ?? new Error('Tournament Exit Recovery Was Interrupted'));
          transaction.onerror = () =>
            finish(transaction?.error ?? new Error('Tournament Exit Recovery Storage Failed'));
          const gate = transaction.objectStore('journal').get('reservation');
          gate.onsuccess = () => {
            if (settled) return;
            try {
              result = work();
            } catch (error) {
              finish(error);
              try {
                transaction?.abort();
              } catch {
                // The failed synchronous storage work already owns the result.
              }
            }
          };
        } catch (error) {
          finish(error);
        }
      };
    } catch (error) {
      finish(error);
    }
  });
}

function browserStorage(kind: 'localStorage' | 'sessionStorage'): StorageLike | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    return window[kind];
  } catch {
    // Accessing the getter itself throws on opaque/blocked origins.
    return undefined;
  }
}

function browserEnvironment(): TournamentUnregisterJournalEnvironment {
  return {
    local: browserStorage('localStorage'),
    session: browserStorage('sessionStorage'),
    createId: uuid,
    lock: (_key, work) => lockTournamentUnregisterJournal(work),
  };
}

function safelyRead(storage: StorageLike | undefined, key: string): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function safelyWrite(storage: StorageLike | undefined, key: string, value: string): boolean {
  if (!storage) return false;
  try {
    storage.setItem(key, value);
    return storage.getItem(key) === value;
  } catch {
    return false;
  }
}

function removeOwned(storage: StorageLike, key: string, requestId: string): void {
  const raw = storage.getItem(key);
  if (!raw) return;
  if ((JSON.parse(raw) as TournamentUnregisterAttempt)?.requestId !== requestId) return;
  storage.removeItem(key);
  if (storage.getItem(key) !== null) {
    throw new Error('The Completed Tournament Exit Could Not Be Cleared');
  }
}

function removeAll(storage: StorageLike, key: string): void {
  storage.removeItem(key);
  if (storage.getItem(key) !== null) {
    throw new Error('The Prior Tournament Exit Could Not Be Cleared');
  }
}

function requireDurableRails(
  environment: TournamentUnregisterJournalEnvironment
): asserts environment is TournamentUnregisterJournalEnvironment & {
  local: StorageLike;
  session: StorageLike;
} {
  if (!environment.local || !environment.session) {
    throw new Error(
      'Tournament Exit Recovery Storage Is Unavailable. No Tournament Exit Was Sent.'
    );
  }
}

function readFrom(
  environment: TournamentUnregisterJournalEnvironment,
  intent: TournamentUnregisterIntent
): TournamentUnregisterAttempt | null {
  const normalizedIntent = normalized(intent);
  const key = keyFor(normalizedIntent);
  // sessionStorage deliberately wins. A sibling tab may acknowledge and remove
  // the shared local record while this tab still owns an unanswered request.
  const raw = safelyRead(environment.session, key) ?? safelyRead(environment.local, key) ?? null;
  return raw === null ? null : decode(raw, normalizedIntent);
}

function persistBoth(
  environment: TournamentUnregisterJournalEnvironment & {
    local: StorageLike;
    session: StorageLike;
  },
  key: string,
  raw: string
): void {
  if (!safelyWrite(environment.local, key, raw) || !safelyWrite(environment.session, key, raw)) {
    throw new Error('The Tournament Exit Request Could Not Be Saved. No Exit Was Sent.');
  }
}

function safelyComplete(storage: StorageLike | undefined, key: string, requestId: string): void {
  if (!storage) return;
  removeOwned(storage, key, requestId);
}

/**
 * Durable operation identity for a money-bearing tournament exit.
 *
 * This is not an offline queue and it has no age-based expiry. An unanswered
 * request must keep its UUID across retries and reloads until the database
 * returns either its immutable receipt or a definitive refusal.
 */
export function createTournamentUnregisterJournal(
  environment: () => TournamentUnregisterJournalEnvironment = browserEnvironment
) {
  const read = (intent: TournamentUnregisterIntent): TournamentUnregisterAttempt | null => {
    return readFrom(environment(), intent);
  };

  return {
    read,
    async reserve(intent: TournamentUnregisterIntent): Promise<TournamentUnregisterAttempt> {
      const normalizedIntent = normalized(intent);
      const env = environment();
      const key = keyFor(normalizedIntent);
      return env.lock(key, () => {
        requireDurableRails(env);
        const existing = readFrom(env, normalizedIntent);
        if (existing) {
          persistBoth(env, key, JSON.stringify(existing));
          return existing;
        }

        const requestId = env.createId();
        if (!UUID.test(requestId)) {
          throw new Error('The Tournament Exit Request Could Not Be Created');
        }
        const attempt: TournamentUnregisterAttempt = {
          version: 1,
          requestId,
          intent: normalizedIntent,
        };
        persistBoth(env, key, JSON.stringify(attempt));
        return attempt;
      });
    },
    async complete(attempt: TournamentUnregisterAttempt): Promise<void> {
      const env = environment();
      const key = keyFor(attempt.intent);
      await env.lock(key, () => {
        safelyComplete(env.session, key, attempt.requestId);
        safelyComplete(env.local, key, attempt.requestId);
      });
    },
    async discard(intent: TournamentUnregisterIntent): Promise<void> {
      const env = environment();
      const key = keyFor(intent);
      await env.lock(key, () => {
        if (env.session) removeAll(env.session, key);
        if (env.local) removeAll(env.local, key);
      });
    },
  };
}

export const tournamentUnregisterJournal = createTournamentUnregisterJournal();
