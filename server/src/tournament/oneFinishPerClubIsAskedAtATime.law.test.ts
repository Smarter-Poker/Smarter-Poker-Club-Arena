/**
 * ONE FINISH PER CLUB IS ASKED AT A TIME (2026-10-03).
 *
 * fn_complete_tournament_terminal holds the club's bank-scope finish lock for
 * the whole settlement (2-12 s of CPU in Postgres). Once decided games stopped
 * queueing in the elimination scheduler (#5958), other finishes of the same
 * club waited in the lock queue instead and were cancelled by the 8 s
 * lock_timeout: 28-66 cancelled finishes every fifteen minutes, against 0-4
 * before, each retried with backoff behind newer arrivals.
 *
 * The law: a terminal finish attempt for a club is sent only when that club's
 * previous attempt has answered, in arrival order; different clubs, and
 * requests without a club, are not held; a failure releases the lane.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), verify: vi.fn() }));
vi.mock('../services/supabase.js', () => ({
  supabase: { rpc: mocks.rpc, from: mocks.from },
  maintenanceSupabase: { rpc: mocks.rpc, from: mocks.from },
}));
vi.mock('./completionSettlementReceipt.js', () => ({
  verifyTournamentCompletionReceipt: mocks.verify,
  parseLegacyFeeCustodyOrigin: vi.fn(),
}));

import {
  noteTerminalFinishClub,
  requestTournamentTerminalReceipt,
  terminalFinishLanesInUse,
  withTerminalFinishLane,
} from './terminalSettlementRpc.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CLUB = id(70);
const OTHER_CLUB = id(71);
const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function gate() {
  let open!: () => void;
  let fail!: (error: unknown) => void;
  const promise = new Promise<string>((resolve, reject) => {
    open = () => resolve('ok');
    fail = reject;
  });
  return { promise, open, fail };
}

beforeEach(() => {
  mocks.rpc.mockReset();
  mocks.verify.mockReset();
});

describe('one finish per club is asked at a time', () => {
  it('a second finish of the same club is sent only after the first answers, in order', async () => {
    const started: string[] = [];
    const first = gate();
    const second = gate();
    const third = gate();
    const a = withTerminalFinishLane(CLUB, async () => (started.push('a'), first.promise));
    const b = withTerminalFinishLane(CLUB, async () => (started.push('b'), second.promise));
    const c = withTerminalFinishLane(CLUB, async () => (started.push('c'), third.promise));
    await flush();
    expect(started).toEqual(['a']);
    first.open();
    await a;
    await flush();
    expect(started).toEqual(['a', 'b']);
    second.open();
    third.open();
    await Promise.all([b, c]);
    expect(started).toEqual(['a', 'b', 'c']);
    expect(terminalFinishLanesInUse()).toBe(0);
  });

  it('different clubs, and a request with no club, are not held', async () => {
    const started: string[] = [];
    const held = gate();
    const a = withTerminalFinishLane(CLUB, async () => (started.push('club'), held.promise));
    const b = withTerminalFinishLane(OTHER_CLUB, async () => (started.push('other'), 'ok'));
    const c = withTerminalFinishLane(null, async () => (started.push('none'), 'ok'));
    try {
      await flush();
      expect([...started].sort()).toEqual(['club', 'none', 'other']);
      await Promise.all([b, c]);
    } finally {
      held.open();
      await a;
    }
    expect(terminalFinishLanesInUse()).toBe(0);
  });

  it('a failed or thrown attempt releases the lane', async () => {
    const started: string[] = [];
    const first = gate();
    const a = withTerminalFinishLane(CLUB, async () => (started.push('a'), first.promise));
    const b = withTerminalFinishLane(CLUB, async () => {
      started.push('b');
      throw new Error('socket hang up');
    });
    const c = withTerminalFinishLane(CLUB, async () => (started.push('c'), 'ok'));
    first.promise.catch(() => undefined);
    first.fail(new Error('lock timeout'));
    await expect(a).rejects.toThrow('lock timeout');
    await expect(b).rejects.toThrow('socket hang up');
    await expect(c).resolves.toBe('ok');
    expect(started).toEqual(['a', 'b', 'c']);
    expect(terminalFinishLanesInUse()).toBe(0);
  });

  it('two finishes of one club reach fn_complete_tournament_terminal one after the other', async () => {
    const answers: Array<() => void> = [];
    const sent: string[] = [];
    mocks.rpc.mockImplementation(
      (name: string, args: { p_tournament_id: string }) =>
        new Promise((resolve) => {
          sent.push(`${name}:${args.p_tournament_id.slice(-2)}`);
          answers.push(() => resolve({ data: { ok: true }, error: null }));
        })
    );
    mocks.verify.mockReturnValue({ ok: true });
    const one = requestTournamentTerminalReceipt(id(1), 'places', id(11), { clubId: CLUB });
    const two = requestTournamentTerminalReceipt(id(2), 'places', id(12), { clubId: CLUB });
    await flush();
    expect(sent).toEqual(['fn_complete_tournament_terminal:01']);
    answers.shift()!();
    await one;
    await flush();
    expect(sent).toEqual([
      'fn_complete_tournament_terminal:01',
      'fn_complete_tournament_terminal:02',
    ]);
    answers.shift()!();
    await two;
  });

  it('a finish without an explicit club uses the club its manager noted', async () => {
    const answers: Array<() => void> = [];
    const sent: string[] = [];
    mocks.rpc.mockImplementation(
      (name: string, args: { p_tournament_id: string }) =>
        new Promise((resolve) => {
          sent.push(args.p_tournament_id.slice(-2));
          answers.push(() => resolve({ data: { ok: true }, error: null }));
        })
    );
    mocks.verify.mockReturnValue({ ok: true });
    noteTerminalFinishClub(id(3), CLUB);
    noteTerminalFinishClub(id(4), CLUB);
    noteTerminalFinishClub(id(5), OTHER_CLUB);
    const three = requestTournamentTerminalReceipt(id(3), 'places', id(13));
    const four = requestTournamentTerminalReceipt(id(4), 'places', id(14));
    const five = requestTournamentTerminalReceipt(id(5), 'places', id(15));
    // An unnoted tournament is sent at once, as before.
    const six = requestTournamentTerminalReceipt(id(6), 'places', id(16));
    await flush();
    expect(sent.sort()).toEqual(['03', '05', '06']);
    while (answers.length) answers.shift()!();
    await flush();
    expect(sent).toContain('04');
    while (answers.length) answers.shift()!();
    await Promise.all([three, four, five, six]);
  });

  it('every manager notes its club where it loads the tournament row', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('./TournamentManagerBase.ts', import.meta.url), 'utf8');
    const loads = source.match(
      /this\.tournamentCache = tournament;\n\s*noteTerminalFinishClub\(this\.tournamentId, tournament\.club_id\);/g
    );
    expect(loads?.length).toBe((source.match(/this\.tournamentCache = tournament;/g) ?? []).length);
    expect(loads?.length).toBeGreaterThan(0);
  });
});
