import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  withTournamentPurchaseIntent,
  TournamentPurchaseNotSubmittedError,
  type TournamentPurchaseRequest,
} from '../../src/services/TournamentPurchaseIntent';

const scope = { userId: 'player', tournamentId: 'event', kind: 'rebuy' as const };
const key = 'ca:tournament-purchase:v1:player:event:rebuy';
const payload = (): TournamentPurchaseRequest => ({
  p_user_id: 'player',
  p_tournament_id: 'event',
  p_rebuy_type: 'rebuy',
  p_cost: 10,
  p_chips: 1000,
  p_current_level: 3,
  p_client_token: null,
});
function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    key: (i) => [...values.keys()][i] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}
beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  vi.stubGlobal('sessionStorage', memoryStorage());
  let lane = Promise.resolve();
  vi.stubGlobal('navigator', {
    locks: {
      request: (_key: string, fn: () => Promise<number>) => {
        const work = lane.then(fn);
        lane = work.then(
          () => undefined,
          () => undefined
        );
        return work;
      },
    },
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Tournament Original Purchase Intent', () => {
  it('keeps a published intent unknown when readback fails and a queued tab submits it', async () => {
    vi.resetModules();
    const other = (await import('../../src/services/TournamentPurchaseIntent'))
      .withTournamentPurchaseIntent;
    const readShared = localStorage.getItem.bind(localStorage);
    const writeShared = localStorage.setItem.bind(localStorage);
    let failReadback = false;
    let published = false;
    vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      writeShared(key, value);
      if (!published) {
        published = true;
        failReadback = true;
      }
    });
    vi.spyOn(localStorage, 'getItem').mockImplementation((key) => {
      if (failReadback) {
        failReadback = false;
        throw new Error('Readback lost');
      }
      return readShared(key);
    });
    const originSubmit = vi.fn(async () => 1000);
    const origin = withTournamentPurchaseIntent(scope, async () => payload(), originSubmit);
    vi.stubGlobal('sessionStorage', memoryStorage());
    const queuedBuild = vi.fn(async () => ({ ...payload(), p_cost: 50 }));
    const queuedSubmit = vi.fn(async (_request: TournamentPurchaseRequest) => 1000);
    const queued = other(scope, queuedBuild, queuedSubmit);
    const [originResult, queuedResult] = await Promise.allSettled([origin, queued]);
    expect(originResult.status).toBe('rejected');
    if (originResult.status !== 'rejected') throw new Error('Expected failed readback');
    expect(originResult.reason).not.toBeInstanceOf(TournamentPurchaseNotSubmittedError);
    expect(originResult.reason.message).toBe('Readback lost');
    expect(originSubmit).not.toHaveBeenCalled();
    expect(queuedResult).toEqual({ status: 'fulfilled', value: 1000 });
    expect(queuedBuild).not.toHaveBeenCalled();
    expect(queuedSubmit).toHaveBeenCalledOnce();
    expect(queuedSubmit.mock.calls[0][0].p_cost).toBe(10);
  });
  it('distinguishes a fresh local preflight failure from a purchase that reached the server', async () => {
    const submit = vi.fn(async () => 1000);
    await expect(
      withTournamentPurchaseIntent(
        scope,
        async () => {
          throw new Error('Quote unavailable');
        },
        submit
      )
    ).rejects.toBeInstanceOf(TournamentPurchaseNotSubmittedError);
    expect(submit).not.toHaveBeenCalled();
    expect(localStorage.getItem(key)).toBeNull();
    await expect(
      withTournamentPurchaseIntent(
        scope,
        async () => payload(),
        async () => {
          throw new Error('Lost reply');
        }
      )
    ).rejects.not.toBeInstanceOf(TournamentPurchaseNotSubmittedError);
    expect(JSON.parse(localStorage.getItem(key)!).state).toBe('pending');
    vi.spyOn(sessionStorage, 'setItem').mockImplementation(() => {
      throw new Error('Storage unavailable');
    });
    await expect(
      withTournamentPurchaseIntent(scope, async () => payload(), submit)
    ).rejects.not.toBeInstanceOf(TournamentPurchaseNotSubmittedError);
    expect(submit).not.toHaveBeenCalled();
  });
  it('persists the complete payload before sending and retains it after an unknown response', async () => {
    const submit = vi.fn(async (request: TournamentPurchaseRequest) => {
      expect(JSON.parse(localStorage.getItem(key)!).request).toEqual(request);
      expect(JSON.parse(sessionStorage.getItem(key)!).request).toEqual(request);
      throw new Error('Lost Response');
    });
    await expect(
      withTournamentPurchaseIntent(scope, async () => payload(), submit)
    ).rejects.toThrow('Lost Response');
    const request = submit.mock.calls[0][0];
    expect(request.p_client_token).toBeTruthy();
    const unavailable = vi.fn(async () => {
      throw new Error('Window Closed');
    });
    const replay = vi.fn(async (_request: TournamentPurchaseRequest) => 2500);
    await expect(withTournamentPurchaseIntent(scope, unavailable, replay)).resolves.toBe(2500);
    expect(unavailable).not.toHaveBeenCalled();
    expect(replay).toHaveBeenCalledWith(request);
  });

  it('survives a module reload without recomputing the original quote or level', async () => {
    const first = vi.fn(async () => {
      throw new Error('Disconnected');
    });
    await expect(
      withTournamentPurchaseIntent(scope, async () => payload(), first)
    ).rejects.toThrow();
    const saved = JSON.parse(localStorage.getItem(key)!).request;
    vi.resetModules();
    const { withTournamentPurchaseIntent: reload } =
      await import('../../src/services/TournamentPurchaseIntent');
    const build = vi.fn(async () => ({ ...payload(), p_cost: 50, p_current_level: 9 }));
    const submit = vi.fn(async (_request: TournamentPurchaseRequest) => 1000);
    await expect(reload(scope, build, submit)).resolves.toBe(1000);
    expect(build).not.toHaveBeenCalled();
    expect(submit).toHaveBeenCalledWith(saved);
  });

  it('preserves one request when two independently loaded tabs queue the same purchase', async () => {
    vi.resetModules();
    const other = (await import('../../src/services/TournamentPurchaseIntent'))
      .withTournamentPurchaseIntent;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const submit = vi.fn(async () => {
      await gate;
      return 1000;
    });
    const build = vi.fn(async () => payload());
    const one = withTournamentPurchaseIntent(scope, build, submit);
    vi.stubGlobal('sessionStorage', memoryStorage());
    const two = other(scope, build, submit);
    await Promise.resolve();
    release();
    await expect(Promise.all([one, two])).resolves.toEqual([1000, 1000]);
    expect(build).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0]).toEqual(submit.mock.calls[1]);
  });

  it('keeps an older tab retry from replacing a newer pending purchase', async () => {
    const fail = async () => {
      throw new Error('Unknown');
    };
    await expect(
      withTournamentPurchaseIntent({ ...scope, token: 'first' }, async () => payload(), fail)
    ).rejects.toThrow();
    const olderSession = sessionStorage;
    vi.stubGlobal('sessionStorage', memoryStorage());
    await withTournamentPurchaseIntent(
      scope,
      async () => payload(),
      async () => 1000
    );
    await expect(
      withTournamentPurchaseIntent({ ...scope, token: 'second' }, async () => payload(), fail)
    ).rejects.toThrow();
    const newerPending = localStorage.getItem(key);
    vi.stubGlobal('sessionStorage', olderSession);
    const replay = vi.fn(async (_request: TournamentPurchaseRequest) => 1000);
    await withTournamentPurchaseIntent(scope, async () => payload(), replay);
    expect(replay.mock.calls[0][0].p_client_token).toBe('first');
    expect(localStorage.getItem(key)).toBe(newerPending);
  });

  it('does not overwrite a newer confirmed purchase when an older tab retries', async () => {
    await expect(
      withTournamentPurchaseIntent(
        { ...scope, token: 'first' },
        async () => payload(),
        async () => {
          throw new Error('Unknown');
        }
      )
    ).rejects.toThrow();
    const olderSession = sessionStorage;
    vi.stubGlobal('sessionStorage', memoryStorage());
    await withTournamentPurchaseIntent(
      scope,
      async () => payload(),
      async () => 1000
    );
    await withTournamentPurchaseIntent(
      { ...scope, token: 'second' },
      async () => payload(),
      async () => 2000
    );
    const newerResolved = localStorage.getItem(key);
    vi.stubGlobal('sessionStorage', olderSession);
    await withTournamentPurchaseIntent(
      scope,
      async () => payload(),
      async () => 1000
    );
    expect(localStorage.getItem(key)).toBe(newerResolved);
  });

  it('creates a distinct token for a later successful rebuy', async () => {
    const submit = vi.fn(async (_request: TournamentPurchaseRequest) => 1000);
    await withTournamentPurchaseIntent(scope, async () => payload(), submit);
    await withTournamentPurchaseIntent(scope, async () => payload(), submit);
    expect(submit.mock.calls[0][0].p_client_token).not.toBe(submit.mock.calls[1][0].p_client_token);
  });

  it('replays the original explicit prompt after acknowledgement', async () => {
    const original = { ...scope, token: 'prompt' };
    const build = vi.fn(async () => payload());
    const submit = vi.fn(async (_request: TournamentPurchaseRequest) => 0);
    await withTournamentPurchaseIntent(original, build, submit);
    await withTournamentPurchaseIntent(original, build, submit);
    expect(build).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0]).toEqual(submit.mock.calls[1]);
  });

  it('replays a confirmed one-per-event add-on before current eligibility checks', async () => {
    const addonScope = { ...scope, kind: 'addon' as const };
    const build = vi.fn(async () => ({ ...payload(), p_rebuy_type: 'addon' as const }));
    const submit = vi.fn(async (_request: TournamentPurchaseRequest) => 3000);
    await withTournamentPurchaseIntent(addonScope, build, submit);
    const closed = vi.fn(async () => {
      throw new Error('Add-On Period Ended');
    });
    await expect(withTournamentPurchaseIntent(addonScope, closed, submit)).resolves.toBe(3000);
    expect(closed).not.toHaveBeenCalled();
    expect(submit.mock.calls[0]).toEqual(submit.mock.calls[1]);
  });

  it.each([
    '{invalid',
    JSON.stringify({ version: 7 }),
    JSON.stringify({
      version: 1,
      state: 'pending',
      request: { ...payload(), p_user_id: 'someone-else' },
    }),
  ])('rejects corrupted or foreign saved requests before calling the server', async (raw) => {
    localStorage.setItem(key, raw);
    const submit = vi.fn(async (_request: TournamentPurchaseRequest) => 1000);
    await expect(
      withTournamentPurchaseIntent(scope, async () => payload(), submit)
    ).rejects.toThrow();
    expect(submit).not.toHaveBeenCalled();
  });

  it('does not send when persistence is unavailable', async () => {
    vi.spyOn(sessionStorage, 'setItem').mockImplementation(() => {
      throw new Error('Storage Full');
    });
    const submit = vi.fn(async (_request: TournamentPurchaseRequest) => 1000);
    await expect(
      withTournamentPurchaseIntent(scope, async () => payload(), submit)
    ).rejects.toThrow('Storage Full');
    expect(submit).not.toHaveBeenCalled();
  });

  it('returns a confirmed outcome when acknowledgement storage fails', async () => {
    const submit = vi.fn(async () => {
      vi.spyOn(sessionStorage, 'setItem').mockImplementation(() => {
        throw new Error('Storage Full');
      });
      return 2500;
    });
    await expect(withTournamentPurchaseIntent(scope, async () => payload(), submit)).resolves.toBe(
      2500
    );
    expect(JSON.parse(localStorage.getItem(key)!).state).toBe('pending');
  });

  it('does not send without a cross-tab lock', async () => {
    vi.stubGlobal('navigator', {});
    const submit = vi.fn(async (_request: TournamentPurchaseRequest) => 1000);
    await expect(
      withTournamentPurchaseIntent(scope, async () => payload(), submit)
    ).rejects.toThrow('Safely Save');
    expect(submit).not.toHaveBeenCalled();
  });
});
