import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { readFileSync } from 'node:fs';

const mocks = vi.hoisted(() => ({ from: vi.fn(), resolve: vi.fn(), report: vi.fn() }));
vi.mock('../src/lib/supabase', () => ({ supabase: { from: mocks.from } }));
vi.mock('../src/core/MasterBus', () => ({
  masterBus: { subscribeDebounced: vi.fn(() => vi.fn()) },
}));
vi.mock('../src/services/UnionApiService', () => ({ unionApi: {} }));
vi.mock('../src/utils/errorReporter', () => ({ reportError: mocks.report }));
vi.mock('react-router-dom', () => ({ useParams: () => ({}) }));
vi.mock('../src/utils/clubIdResolver', async (original) => ({
  ...(await original<typeof import('../src/utils/clubIdResolver')>()),
  resolveClubUUID: mocks.resolve,
}));
import { isUUID } from '../src/utils/clubIdResolver';
import UnionService from '../src/services/UnionService';
import ClubAnnouncementBanner from '../src/components/club/ClubAnnouncementBanner';

const ID = '00000000-0000-4000-8000-000000000001';
function chain(data: unknown = null, error: unknown = null) {
  const value: any = { data, error, count: 0 };
  for (const name of ['select', 'eq', 'or', 'order', 'is', 'limit'])
    value[name] = vi.fn(() => value);
  value.maybeSingle = vi.fn(async () => ({ data, error }));
  value.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve({ data, error, count: 0 }).then(resolve);
  return value;
}
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mocks.from.mockReturnValue(chain());
  mocks.resolve.mockImplementation(async (id: string) => id);
});
afterEach(cleanup);

describe('resolved query identities at actual callers', () => {
  it.each(['demo', '', 'guest'])('does not query a union UUID column with %s', async (id) => {
    expect(await UnionService.getUnion(id)).toBeNull();
    expect(mocks.from).not.toHaveBeenCalled();
  });
  it('retains the real union read and its error', async () => {
    const query = chain(null, new Error('read denied'));
    mocks.from.mockReturnValue(query);
    await expect(UnionService.getUnion(ID)).rejects.toThrow('read denied');
    expect(query.eq).toHaveBeenCalledWith('id', ID);
  });
  it('mounts an unresolved announcement route without an invalid downstream UUID request', async () => {
    await act(async () => {
      render(<ClubAnnouncementBanner clubId="demo" />);
    });
    expect(mocks.resolve).toHaveBeenCalledWith('demo');
    expect(mocks.from).not.toHaveBeenCalled();
  });
  it('resolves a real club slug before loading announcements', async () => {
    mocks.resolve.mockResolvedValue(ID);
    const query = chain([]);
    mocks.from.mockReturnValue(query);
    await act(async () => {
      render(<ClubAnnouncementBanner clubId="real-club" />);
    });
    expect(mocks.from).toHaveBeenCalledWith('club_announcements');
    expect(query.eq).toHaveBeenCalledWith('club_id', ID);
  });
  it('discards an old club resolution after moving to an unresolved route', async () => {
    let finish!: (value: string) => void;
    mocks.resolve.mockImplementation((id: string) =>
      id === 'old-club'
        ? new Promise<string>((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(id)
    );
    const view = render(<ClubAnnouncementBanner clubId="old-club" />);
    await act(async () => {
      view.rerender(<ClubAnnouncementBanner clubId="demo" />);
    });
    await act(async () => {
      finish(ID);
    });
    expect(mocks.from).not.toHaveBeenCalled();
  });

  // Execute the maintained TablePage paid-entry block, preserving its real
  // control flow without mounting the unrelated full poker renderer.
  async function paidEntry(userId: string) {
    const source = readFileSync('src/pages/TablePage.tsx', 'utf8');
    const marker = source.indexOf('IS THE VIEWER A PAID ENTRANT WAITING ON A SEAT?');
    const start = source.indexOf('            if (', marker);
    const end = source.indexOf('\n          } else {', start);
    expect(marker).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const setAwaiting = vi.fn();
    await new AsyncFunction(
      'userId',
      'table',
      'supabase',
      'reportError',
      'isMounted',
      'setAwaitingTournamentSeat',
      'isUUID',
      source.slice(start, end)
    )(userId, { tournament_id: ID }, { from: mocks.from }, mocks.report, true, setAwaiting, isUUID);
    return setAwaiting;
  }
  it('does not send the pre-authentication guest identity to tournament_players', async () => {
    await paidEntry('guest');
    expect(mocks.from).not.toHaveBeenCalled();
  });
  it('retains paid-entry state on failed authenticated reads', async () => {
    mocks.from.mockReturnValue(chain(null, new Error('temporary outage')));
    const setAwaiting = await paidEntry(ID);
    expect(mocks.from).toHaveBeenCalledWith('tournament_players');
    expect(mocks.report).toHaveBeenCalled();
    expect(setAwaiting).not.toHaveBeenCalled();
  });
  it('retains registered-player awaiting-seat behavior', async () => {
    mocks.from.mockImplementation((table: string) =>
      chain(table === 'tournament_players' ? { status: 'registered', table_id: null } : null)
    );
    const setAwaiting = await paidEntry(ID);
    expect(mocks.from).toHaveBeenCalledWith('table_seats');
    expect(setAwaiting).toHaveBeenCalledWith(true);
  });
});
