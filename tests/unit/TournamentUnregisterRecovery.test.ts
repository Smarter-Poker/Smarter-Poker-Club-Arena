import { describe, expect, it, vi } from 'vitest';
import {
  createTournamentUnregisterJournal,
  type TournamentUnregisterJournalEnvironment,
} from '../../src/services/TournamentUnregisterRecovery';

function storage(seed: Record<string, string> = {}) {
  const values = new Map(Object.entries(seed));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
    values,
  };
}

const immediateLock = async <T>(_key: string, work: () => T): Promise<T> => work();

function serialLock() {
  let tail = Promise.resolve();
  return async <T>(_key: string, work: () => T): Promise<T> => {
    const before = tail;
    let release = () => undefined;
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await before;
    try {
      return work();
    } finally {
      release();
    }
  };
}

describe('TournamentUnregisterRecovery', () => {
  const intent = { kind: 'tournament' as const, userId: 'USER-1', targetId: 'TOURNEY-1' };

  it('reuses one request id after a page reload until an exact result completes it', async () => {
    const local = storage();
    const session = storage();
    const firstCreate = vi.fn(() => '00000000-0000-4000-8000-000000000001');
    const firstEnvironment = (): TournamentUnregisterJournalEnvironment => ({
      local,
      session,
      createId: firstCreate,
      lock: immediateLock,
    });
    const firstPage = createTournamentUnregisterJournal(firstEnvironment);
    const first = await firstPage.reserve(intent);

    const secondCreate = vi.fn(() => '00000000-0000-4000-8000-000000000002');
    const reloadedSession = storage();
    const reloadedPage = createTournamentUnregisterJournal(() => ({
      local,
      session: reloadedSession,
      createId: secondCreate,
      lock: immediateLock,
    }));
    await expect(reloadedPage.reserve(intent)).resolves.toEqual(first);
    expect(secondCreate).not.toHaveBeenCalled();

    await reloadedPage.complete(first);
    const next = await reloadedPage.reserve(intent);
    expect(next.requestId).toBe('00000000-0000-4000-8000-000000000002');
  });

  it('keeps a tab-local unanswered request even if another tab clears shared storage', async () => {
    const local = storage();
    const session = storage();
    const journal = createTournamentUnregisterJournal(() => ({
      local,
      session,
      createId: () => '00000000-0000-4000-8000-000000000003',
      lock: immediateLock,
    }));
    const first = await journal.reserve({ ...intent, targetId: 'TOURNEY-2' });
    local.values.clear();
    expect((await journal.reserve({ ...intent, targetId: 'TOURNEY-2' })).requestId).toBe(
      first.requestId
    );
  });

  it('fails closed on a corrupted saved operation instead of minting a replacement id', async () => {
    const local = storage();
    const session = storage();
    const journal = createTournamentUnregisterJournal(() => ({
      local,
      session,
      createId: () => '00000000-0000-4000-8000-000000000004',
      lock: immediateLock,
    }));
    await journal.reserve({ ...intent, targetId: 'TOURNEY-3' });
    for (const key of session.values.keys()) {
      session.values.set(key, '{"version":1,"requestId":"bad"}');
    }
    await expect(journal.reserve({ ...intent, targetId: 'TOURNEY-3' })).rejects.toThrow(
      /saved tournament exit could not be verified/i
    );
  });

  it('serializes two tabs so they reserve one shared operation identity', async () => {
    const local = storage();
    const lock = serialLock();
    const firstCreate = vi.fn(() => '00000000-0000-4000-8000-000000000005');
    const secondCreate = vi.fn(() => '00000000-0000-4000-8000-000000000006');
    const first = createTournamentUnregisterJournal(() => ({
      local,
      session: storage(),
      createId: firstCreate,
      lock,
    }));
    const second = createTournamentUnregisterJournal(() => ({
      local,
      session: storage(),
      createId: secondCreate,
      lock,
    }));

    const [left, right] = await Promise.all([first.reserve(intent), second.reserve(intent)]);
    expect(right.requestId).toBe(left.requestId);
    expect(firstCreate).toHaveBeenCalledTimes(1);
    expect(secondCreate).not.toHaveBeenCalled();
  });

  it('refuses to send an exit unless both durable rails verify the exact bytes', async () => {
    const createId = vi.fn(() => '00000000-0000-4000-8000-000000000007');
    const unavailable = createTournamentUnregisterJournal(() => ({
      createId,
      lock: immediateLock,
    }));
    await expect(unavailable.reserve(intent)).rejects.toThrow(/no tournament exit was sent/i);
    expect(createId).not.toHaveBeenCalled();

    const brokenSession = storage();
    brokenSession.setItem = () => {
      throw new Error('blocked');
    };
    const unverifiable = createTournamentUnregisterJournal(() => ({
      local: storage(),
      session: brokenSession,
      createId,
      lock: immediateLock,
    }));
    await expect(unverifiable.reserve(intent)).rejects.toThrow(/no exit was sent/i);
  });

  it('starts a fresh request only after a confirmed new lifecycle discards the prior one', async () => {
    const local = storage();
    const session = storage();
    const ids = ['00000000-0000-4000-8000-000000000008', '00000000-0000-4000-8000-000000000009'];
    const journal = createTournamentUnregisterJournal(() => ({
      local,
      session,
      createId: () => ids.shift()!,
      lock: immediateLock,
    }));
    const seat = { ...intent, kind: 'seat' as const, targetId: 'TABLE-1' };
    const oldAttempt = await journal.reserve(seat);
    await journal.discard(seat);
    const nextAttempt = await journal.reserve(seat);
    expect(nextAttempt.requestId).not.toBe(oldAttempt.requestId);
  });
});
