/**
 * A REFUSED HORSE ENTRY IS NOT ASKED EVERY PASS, AND A DATABASE THAT DID NOT
 * ANSWER ENDS THE PASS (2026-10-12).
 *
 * 2026-10-11 17:50 to 18:53 UTC: the ticket door refused every late ticket
 * entry, the horse pass re-offered the same holders every five minutes, and
 * each abandoned call kept running inside the API until the pool was gone.
 * See horseEntryRefusalBackoff.ts and docs/changelog/2026-10-12-a-late-ticket-entry-expects-the-running-count.md.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TournamentRecurringService } from './TournamentRecurringService.js';
import { supabase } from './supabase.js';
import { reportError } from './errorReporter.js';
import {
  HORSE_ENTRY_FIRST_RECHECK_MS,
  HORSE_ENTRY_MAX_RECHECK_MS,
  HorseEntryRefusalBackoff,
} from './horseEntryRefusalBackoff.js';

vi.mock('../maintenance/freezeState.js', () => ({ isMaintenanceFrozen: () => false }));
vi.mock('./errorReporter.js', () => ({ reportError: vi.fn() }));
beforeEach(() => vi.mocked(reportError).mockClear());
afterEach(() => vi.restoreAllMocks());

const T = 'bbbbbbbb-2222-4222-8222-222222222222';
const horse = (id: string) => ({ id, display_name: id, username: id, use_real_name: false });
type Answer = { data: unknown; error: { message: string; code?: string } | null };

function harness(ids: string[], answer: () => Answer) {
  const svc = new TournamentRecurringService() as any;
  let clock = 1_000_000;
  svc.horseEntryBackoff = new HorseEntryRefusalBackoff(
    () => clock,
    () => 1
  );
  const target = {
    variant: 'freezeout',
    format_contract: 'mtt-v1',
    max_players: 200,
    club_id: null,
    start_time: new Date(Date.now() - 600000).toISOString(),
    prize_pool_finalized: false,
    buy_in_amount: 180,
    buy_in_fee: 20,
  };
  vi.spyOn(svc, 'horseLoadMap').mockResolvedValue(new Map<string, number>());
  vi.spyOn(svc, 'clubMemberIdsForTournament').mockResolvedValue(new Set(ids));
  const rpc = vi.fn(
    async (name: string): Promise<any> =>
      name === 'fn_horse_tournament_entry_ticket_hints'
        ? { data: { ok: true, holder_ids: ids }, error: null }
        : answer()
  );
  vi.spyOn(supabase, 'rpc').mockImplementation(rpc as never);
  vi.spyOn(supabase, 'from').mockImplementation((table: string) => {
    const b: Record<string, any> = {};
    for (const m of ['select', 'eq', 'in', 'is', 'gt', 'order', 'limit', 'range', 'update'])
      b[m] = () => b;
    const data = table === 'tournaments' ? target : table === 'profiles' ? ids.map(horse) : [];
    const result = () => ({ data, error: null, count: 24 });
    b.maybeSingle = async () => result();
    b.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result()).then(resolve);
    return b as never;
  });
  const entries = () =>
    rpc.mock.calls.filter(([name]) => name === 'fn_register_horse_for_tournament').length;
  return { svc, entries, advance: (ms: number) => (clock += ms) };
}

describe('a refused horse entry is not asked every pass', () => {
  it('a refused candidate does not consume the successful entry quota', async () => {
    let calls = 0;
    const { svc, entries } = harness(['h1', 'h2', 'h3'], () => ({
      data:
        ++calls === 1
          ? { ok: false, reason: 'horse_tournament_reservation_budget' }
          : { ok: true, registration_id: 'paid-entry' },
      error: null,
    }));
    expect(await svc.registerHorses(T, 1)).toBe(1);
    expect(entries()).toBe(2);
  });

  it('retains the original cap-refused request identity without retrying or altering entry', async () => {
    const id = 'aaaaaaaa-1111-4111-8111-111111111111';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { svc, entries } = harness([id], () => ({
      data: null,
      error: {
        code: '23514',
        message: `FOUR TABLE LIMIT: user ${id} is already committed to 4 games and may not enter another`,
      },
    }));
    const before = Date.now();
    expect(await svc.topUpWithHorses(T, 0, { redeemTickets: true })).toBe(0);
    const prefix = '[TournamentRecurring] horse_entry_cap_refused ';
    const line = warn.mock.calls
      .map(([message]) => String(message))
      .find((s) => s.startsWith(prefix));
    expect(
      line,
      'the aggregate warning loses the original tournament and attempt identity'
    ).toBeDefined();
    const record = JSON.parse(line!.slice(prefix.length));
    expect(record).toEqual({
      version: 1,
      tournamentId: T,
      horseId: id,
      sqlstate: '23514',
      load: 4,
      attemptedAt: expect.any(String),
    });
    expect(Date.parse(record.attemptedAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(record.attemptedAt)).toBeLessThanOrEqual(Date.now());
    expect(entries()).toBe(1);
    await svc.topUpWithHorses(T, 0, { redeemTickets: true });
    expect(entries()).toBe(1);
    expect(warn.mock.calls.filter(([message]) => String(message).startsWith(prefix))).toHaveLength(
      1
    );
  });

  it.each(['wrong_actor', 'wrong_sqlstate', 'other_constraint', 'extra_payload'])(
    'does not label %s as an attributable booking-cap refusal',
    async (kind) => {
      const id = 'aaaaaaaa-1111-4111-8111-111111111111';
      const other = 'cccccccc-3333-4333-8333-333333333333';
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const message = `FOUR TABLE LIMIT: user ${kind === 'wrong_actor' ? other : id} is already committed to 4 games and may not enter another`;
      const { svc, entries } = harness([id], () => ({
        data: null,
        error: {
          code: kind === 'wrong_sqlstate' ? '55000' : '23514',
          message:
            kind === 'other_constraint'
              ? 'unrelated check constraint'
              : kind === 'extra_payload'
                ? message + ' private-token'
                : message,
        },
      }));
      expect(await svc.topUpWithHorses(T, 0, { redeemTickets: true })).toBe(0);
      expect(entries()).toBe(1);
      expect(
        warn.mock.calls.some(([m]) =>
          String(m).startsWith('[TournamentRecurring] horse_entry_cap_refused ')
        )
      ).toBe(false);
    }
  );

  it('defers a horse whose entry came back as an error, then asks again after the backoff', async () => {
    const { svc, entries, advance } = harness(['h1', 'h2'], () => ({
      data: null,
      error: { message: 'ticket admission tournament cache changed', code: '55000' },
    }));
    expect(await svc.topUpWithHorses(T, 0, { redeemTickets: true })).toBe(0);
    expect(entries()).toBe(2);
    // The next pass (five minutes later) does not re-drive a door that refused.
    advance(5 * 60 * 1000);
    expect(await svc.topUpWithHorses(T, 0, { redeemTickets: true })).toBe(0);
    expect(entries()).toBe(2);
    // Once the first backoff has passed, each horse is asked once more.
    advance(HORSE_ENTRY_FIRST_RECHECK_MS);
    await svc.topUpWithHorses(T, 0, { redeemTickets: true });
    expect(entries()).toBe(4);
    // A second refusal doubles the wait: the old interval is no longer enough.
    advance(HORSE_ENTRY_FIRST_RECHECK_MS + 1);
    await svc.topUpWithHorses(T, 0, { redeemTickets: true });
    expect(entries()).toBe(4);
    advance(HORSE_ENTRY_MAX_RECHECK_MS);
    await svc.topUpWithHorses(T, 0, { redeemTickets: true });
    expect(entries()).toBe(6);
  });

  it('stops the pass at the first call the database did not answer', async () => {
    const { svc, entries } = harness(['h1', 'h2', 'h3'], () => ({
      data: null,
      error: { message: 'supabase_timeout', code: '' },
    }));
    expect(await svc.topUpWithHorses(T, 0, { redeemTickets: true })).toBe(0);
    expect(entries()).toBe(1);
  });

  it('stops the pass on an exhausted API pool', async () => {
    const { svc, entries } = harness(['h1', 'h2', 'h3'], () => ({
      data: null,
      error: { message: 'Timed out acquiring connection from connection pool.', code: 'PGRST003' },
    }));
    await svc.topUpWithHorses(T, 0, { redeemTickets: true });
    expect(entries()).toBe(1);
  });

  it('does not defer a decision the database answered', async () => {
    const { svc, entries } = harness(['h1'], () => ({
      data: { ok: false, reason: 'tournament_full' },
      error: null,
    }));
    await svc.topUpWithHorses(T, 0, { redeemTickets: true });
    await svc.topUpWithHorses(T, 0, { redeemTickets: true });
    expect(entries()).toBe(2);
  });
});
