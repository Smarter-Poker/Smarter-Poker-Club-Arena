import { afterEach, describe, expect, it, vi } from 'vitest';

const loadSeatedPlayers = vi.hoisted(() => vi.fn());
vi.mock('../services/supabase.js', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('../services/supabase.js')),
  loadSeatedPlayers,
}));
const { ServerTableEngine } = await import('./ServerTableEngine.js');

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture() {
  const engine = new ServerTableEngine('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee') as any;
  engine.refreshBlinds = vi.fn().mockResolvedValue(undefined);
  engine.refreshRakeConfig = vi.fn().mockResolvedValue(undefined);
  return engine;
}
afterEach(() => {
  loadSeatedPlayers.mockReset();
  vi.restoreAllMocks();
});

describe('next hand input reads', () => {
  it('starts independent configuration reads while the fresh roster is still loading', async () => {
    const seats = deferred<any[]>();
    const rake = deferred<void>();
    loadSeatedPlayers.mockReturnValue(seats.promise);
    const e = fixture();
    e.refreshRakeConfig.mockReturnValue(rake.promise);
    const work = e.readNextHandInputs();
    try {
      expect(loadSeatedPlayers).toHaveBeenCalledOnce();
      expect(e.refreshBlinds).not.toHaveBeenCalled();
      expect(e.refreshRakeConfig).toHaveBeenCalledOnce();
    } finally {
      seats.resolve([]);
      rake.resolve();
      await work;
    }
  });

  it('keeps the hand blocked until every input has completed', async () => {
    const rake = deferred<void>();
    const roster = [{ user_id: 'fresh-seat', stack: 200 }];
    loadSeatedPlayers.mockResolvedValue(roster);
    const e = fixture();
    e.refreshRakeConfig.mockReturnValue(rake.promise);
    let finished = false;
    const work = e.readNextHandInputs().then((value: unknown) => {
      finished = true;
      return value;
    });
    await vi.waitFor(() => expect(e.refreshRakeConfig).toHaveBeenCalledOnce());
    expect(finished).toBe(false);
    rake.resolve();
    expect(await work).toBe(roster);
  });

  it('drains the other started reads before reporting a failed roster', async () => {
    const seats = deferred<any[]>();
    const rake = deferred<void>();
    loadSeatedPlayers.mockReturnValue(seats.promise);
    const e = fixture();
    e.refreshRakeConfig.mockReturnValue(rake.promise);
    let finished = false;
    const failure = new Error('roster unavailable');
    const outcome = e.readNextHandInputs().then(
      () => {
        finished = true;
        return 'unexpected success';
      },
      (error: unknown) => {
        finished = true;
        return error;
      }
    );
    seats.reject(failure);
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(finished).toBe(false);
      expect(e.refreshRakeConfig).toHaveBeenCalledOnce();
    } finally {
      rake.resolve();
      expect(await outcome).toBe(failure);
    }
  });
});
