/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A LEASE IS NOT LOST BECAUSE NOBODY ASKED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS (2026-09-21)
 *
 * 403 tournament hands lost their history between 2026-09-08 and 2026-09-18,
 * every one of them refused with:
 *
 *     atomic hand commit refused (lease_proof_expired)
 *
 * No lease was ever lost. Across 22,374,805 tournament heartbeats production
 * recorded `taken` = 0 and `stale` = 0, on a deployment with exactly ONE
 * engine instance holding every lease. The losses were manufactured by the
 * client, in three places that turned "we did not get an answer in time" into
 * "this lease is gone":
 *
 *   1. ONE WINDOW PER PASS. `now + 20s` was taken once, before the first
 *      request went out, and handed to every batch of the pass. The fleet is
 *      drained 500 claims per request over 4 workers, so a 13,000-tournament
 *      pass is 27 batches and SEVEN rounds per worker. The seventh round spent
 *      the shared window queueing; the database answered `kept` and the answer
 *      was discarded for arriving late.
 *
 *   2. A LATE `kept` WAS FILED AS A LOSS. Having failed the window test, the
 *      row fell through to `lostTournamentIds` - the same bucket as `taken`.
 *
 *   3. A BATCH THAT WAS NEVER SENT NAMED ALL 500 OF ITS CLAIMS AS LOST,
 *      without asking the database anything at all.
 *
 * GameServer fences every named manager, which kills every table engine under
 * it, which discards whatever hand that table was committing. The arithmetic
 * is visible in production, and it is a step function on rounds-per-worker:
 *
 *     date        tournaments  batches  rounds  hands lost
 *     2026-09-13        1,694        4       1           0
 *     2026-09-15          140        1       1           0
 *     2026-09-19        1,577        4       1           0
 *     2026-09-21           61        1       1           0
 *     2026-09-16        3,950        8       2          10
 *     2026-09-14        4,528       10       3          17
 *     2026-09-17       13,813       28       7         146
 *     2026-09-18       13,082       27       7         284
 *
 * Every day whose fleet fitted in ONE round lost nothing.
 *
 * ── WHAT THIS LAW PINS ────────────────────────────────────────────────────
 *
 * The client may withhold a renewal for any reason. It may report a LOSS only
 * on evidence of loss. `kept` on the exact generation is the opposite of that
 * evidence, whenever it arrives.
 *
 * ── WHAT IT DOES NOT CHANGE ───────────────────────────────────────────────
 *
 * Nothing here widens what may be retried, and no refusal becomes survivable.
 * A real loss still fences on the first answer: `taken`, `stale`, `missing`,
 * and a `kept` carrying a DIFFERENT generation are all still reported lost,
 * and the last cases here pin that. The 20-second window and the audited
 * 30-second takeover boundary are unchanged; the window is merely measured
 * from the request that earned it instead of from the pass that queued it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.fn();
vi.mock('./supabase/client.js', () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));
vi.mock('./tableLease.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, INSTANCE_ID: 'me', INSTANCE_VERSION: 'v1' };
});

const T = (n: number) => `aaaaaaaa-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const GEN = 'bbbbbbbb-0000-4000-8000-000000000001';
const OTHER_GEN = 'bbbbbbbb-0000-4000-8000-000000000002';

beforeEach(() => {
  vi.resetModules();
  rpc.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  process.env.ENGINE_TOURNAMENT_LEASE_ENFORCE = 'on';
});

const load = async () => await import('./tournamentLease.js');
const claims = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ tournamentId: T(i), leaseGeneration: GEN }));

describe('a renewal that arrives too late to use is still not a loss', () => {
  it('withholds the proof but reports nothing lost', async () => {
    let now = 0;
    rpc.mockImplementation(async () => {
      // The whole window is consumed by the request itself.
      now = 20_000;
      return { data: [{ tournament_id: T(0), state: 'kept', lease_generation: GEN }], error: null };
    });
    const lease = await load();
    lease._setTournamentLeaseMonotonicNowForTests(() => now);

    const out = await lease.heartbeatTournaments(claims(1));
    expect(out.status).toBe('answered');
    if (out.status !== 'answered') throw new Error('expected an answer');
    // Authority is not extended...
    expect(out.proofs).toEqual([]);
    // ...and the manager is not accused of losing a lease it still holds.
    expect(out.lostTournamentIds).toEqual([]);
  });
});

describe('a batch that was never sent asks nothing and accuses nobody', () => {
  it('returns UNKNOWN rather than naming every queued claim as lost', async () => {
    let now = 0;
    const seen: number[] = [];
    rpc.mockImplementation(async (_name: string, args: { p_claims: unknown[] }) => {
      seen.push(args.p_claims.length);
      // Each of the first four requests burns a quarter of the pass window, so
      // the fifth batch reaches the queue guard with nothing left.
      now += 6_000;
      return {
        data: (args.p_claims as Array<{ tournament_id: string }>).map((c) => ({
          tournament_id: c.tournament_id,
          state: 'kept',
          lease_generation: GEN,
        })),
        error: null,
      };
    });
    const lease = await load();
    lease._setTournamentLeaseMonotonicNowForTests(() => now);

    // 2,001 claims = five batches of 500/500/500/500/1 over four workers.
    const out = await lease.heartbeatTournaments(claims(2_001));
    expect(out.status).toBe('answered');
    if (out.status !== 'answered') throw new Error('expected an answer');
    // The batch that never ran contributed no proof AND no accusation.
    expect(out.lostTournamentIds).toEqual([]);
    // It also never reached the database.
    expect(seen.reduce((a, b) => a + b, 0)).toBeLessThan(2_001);
  });
});

describe('the window belongs to the request that earned it', () => {
  it('gives a later wave its own window instead of the pass start', async () => {
    let now = 1_000;
    const issuedAt: number[] = [];
    rpc.mockImplementation(async (_name: string, args: { p_claims: unknown[] }) => {
      issuedAt.push(now);
      now += 2_000;
      return {
        data: (args.p_claims as Array<{ tournament_id: string }>).map((c) => ({
          tournament_id: c.tournament_id,
          state: 'kept',
          lease_generation: GEN,
        })),
        error: null,
      };
    });
    const lease = await load();
    lease._setTournamentLeaseMonotonicNowForTests(() => now);

    const out = await lease.heartbeatTournaments(claims(2_500));
    expect(out.status).toBe('answered');
    if (out.status !== 'answered') throw new Error('expected an answer');
    expect(out.proofs).toHaveLength(2_500);
    expect(out.lostTournamentIds).toEqual([]);

    const deadlines = [...new Set(out.proofs.map((p) => p.proofDeadlineMonotonicMs))];
    // Five waves, five windows. One shared window is the defect.
    expect(issuedAt).toHaveLength(5);
    expect(deadlines).toHaveLength(5);
    // Every window opens at its own request and closes well inside the audited
    // 30s takeover boundary, which is what makes it conservative.
    for (const deadline of deadlines) {
      const issued = Math.max(...issuedAt.filter((t) => t < deadline));
      expect(deadline - issued).toBeLessThanOrEqual(lease.TOURNAMENT_LEASE_PROOF_WINDOW_MS);
      expect(deadline - issued).toBeLessThan(30_000);
    }
  });
});

describe('a lease that is genuinely gone is still refused', () => {
  it.each([
    ['taken', 'another live instance holds it'],
    ['stale', 'the row is past the audited takeover boundary'],
    ['missing', 'there is no row at all'],
  ])('still reports %s as lost (%s)', async (state) => {
    rpc.mockResolvedValue({
      data: [
        { tournament_id: T(0), state: 'kept', lease_generation: GEN },
        { tournament_id: T(1), state, lease_generation: state === 'missing' ? null : GEN },
      ],
      error: null,
    });
    const lease = await load();
    lease._setTournamentLeaseMonotonicNowForTests(() => 0);

    const out = await lease.heartbeatTournaments([
      { tournamentId: T(0), leaseGeneration: GEN },
      { tournamentId: T(1), leaseGeneration: GEN },
    ]);
    expect(out.status).toBe('answered');
    if (out.status !== 'answered') throw new Error('expected an answer');
    expect(out.lostTournamentIds).toEqual([T(1)]);
    expect(out.proofs.map((p) => p.tournamentId)).toEqual([T(0)]);
  });

  it('still reports a kept row carrying a DIFFERENT generation as lost', async () => {
    // This is a takeover that renewed the successor, not us. `kept` alone is
    // never enough - the generation must be ours.
    rpc.mockResolvedValue({
      data: [{ tournament_id: T(0), state: 'kept', lease_generation: OTHER_GEN }],
      error: null,
    });
    const lease = await load();
    lease._setTournamentLeaseMonotonicNowForTests(() => 0);

    const out = await lease.heartbeatTournaments([{ tournamentId: T(0), leaseGeneration: GEN }]);
    expect(out.status).toBe('answered');
    if (out.status !== 'answered') throw new Error('expected an answer');
    expect(out.lostTournamentIds).toEqual([T(0)]);
    expect(out.proofs).toEqual([]);
  });

  it('a late answer does not rescue a generation the database gave away', async () => {
    // The late-arrival path must not become a blanket amnesty: lateness is
    // forgiven only for `kept` on the EXACT generation.
    let now = 0;
    rpc.mockImplementation(async () => {
      now = 20_000;
      return {
        data: [{ tournament_id: T(0), state: 'taken', lease_generation: OTHER_GEN }],
        error: null,
      };
    });
    const lease = await load();
    lease._setTournamentLeaseMonotonicNowForTests(() => now);

    const out = await lease.heartbeatTournaments([{ tournamentId: T(0), leaseGeneration: GEN }]);
    expect(out.status).toBe('answered');
    if (out.status !== 'answered') throw new Error('expected an answer');
    expect(out.lostTournamentIds).toEqual([T(0)]);
  });
});
