/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  EVERY HEARTBEAT CLAIM LANDS IN EXACTLY ONE OUTCOME BUCKET
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS (2026-09-12)
 *
 * `poker_lease_heartbeat_outcomes_total` has carried a `malformed` state since
 * the counter shipped. engineInstruments declares it, zero-seeds it, and
 * documents it as "the response could not be read as an answer".
 *
 * Nothing ever incremented it. Production read exactly 0 for both scopes.
 *
 * Not because the case never happened. Because both whole-answer refusals
 * return ABOVE the per-row loop that is the counter's only writer:
 *
 *     if (malformed || rowsById.size !== claims.length) {
 *       ...
 *       return { status: 'answered', proofs: [], lostTableIds: [...tableIds] };
 *     }
 *     for (const claim of claims) {            // <- the only inc() in the file
 *       leaseHeartbeatOutcomesTotal.inc(1, { scope, state: row.state });
 *
 * That return is the most destructive answer this module can give: it declares
 * EVERY lease in the scope lost at once, and the whole fleet is fenced and
 * rebuilt. It was also the one answer that left no trace in the instruments.
 *
 * ── WHY THE SILENCE MATTERED MORE THAN THE COUNT ──────────────────────────
 *
 * `LeaseHeartbeatsNotBeingKept` is critical severity and pages by SMS. It is a
 * RATIO:
 *
 *     sum by (scope) (rate(outcomes{state!="kept"}[10m]))
 *       / clamp_min(sum by (scope) (rate(outcomes[10m])), 0.001) > 0.05
 *
 * A refusal that increments neither the numerator nor the denominator moves
 * that expression by exactly nothing. So the single worst lease event
 * possible - every lease in a scope lost in one pass - was the one event that
 * alert was structurally unable to see, while the same counters went on
 * reporting a healthy fleet at 99.8% kept.
 *
 * Observed on production 2026-09-12: the tournament fleet was torn down and
 * rebuilt in a single minute, 1,186 to 1,455 tables, once every one to two
 * hours, while `poker_lease_heartbeat_outcomes_total{state="malformed"}` read
 * 0 and `taken` and `stale` both read 0.
 *
 * ── WHAT THIS PINS ─────────────────────────────────────────────────────────
 *
 * The law is an accounting identity, not a threshold: a claim that was sent is
 * a claim that gets an outcome. A refusal to read the answer is an outcome.
 *
 * It deliberately does NOT pin the fail-closed decision itself. Declaring every
 * lease lost on an unreadable answer is a documented safety choice ("must
 * fail-stop before a database takeover is possible"), and this change does not
 * touch it. It only makes the choice visible when it is exercised.
 *
 * A transport failure is the one case that counts nothing, and that is correct:
 * it returns `uncertain`, fences no one, and extends nothing. No claim was
 * answered, so no claim gets an outcome.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const rpc = vi.fn();
vi.mock('./supabase/client.js', () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));
vi.mock('./tableLease.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, INSTANCE_ID: 'me', INSTANCE_VERSION: 'v1' };
});

const inc = vi.fn();
vi.mock('../observability/engineInstruments.js', () => ({
  leaseHeartbeatOutcomesTotal: { inc: (...a: unknown[]) => inc(...a) },
}));

const T1 = '11111111-2222-4333-8444-555555555555';
const T2 = '11111111-2222-4333-8444-555555555556';
const T3 = '11111111-2222-4333-8444-555555555557';
const GEN = 'aaaaaaaa-0000-4000-8000-000000000001';

/** Every `{scope, state}` the module counted, and how many claims it charged. */
const counted = (scope: string, state: string): number =>
  inc.mock.calls
    .filter((c) => {
      const labels = c[1] as { scope?: string; state?: string } | undefined;
      return labels?.scope === scope && labels?.state === state;
    })
    .reduce((sum, c) => sum + Number(c[0]), 0);

beforeEach(() => {
  rpc.mockReset();
  inc.mockReset();
  vi.resetModules();
  process.env.ENGINE_LEASE_ENFORCE = 'on';
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.ENGINE_LEASE_ENFORCE;
});

describe('a cash answer nobody can read still accounts for every claim', () => {
  it('charges one malformed outcome per claim when the row set is short', async () => {
    const { heartbeatTables } = await import('./tableLease.js');
    // Two rows answered for three claims. The module declares all three lost.
    rpc.mockResolvedValue({
      data: [
        { table_id: T1, state: 'kept', lease_generation: GEN },
        { table_id: T2, state: 'kept', lease_generation: GEN },
      ],
      error: null,
    });

    const out = await heartbeatTables([
      { tableId: T1, leaseGeneration: GEN },
      { tableId: T2, leaseGeneration: GEN },
      { tableId: T3, leaseGeneration: GEN },
    ]);

    expect(out.status).toBe('answered');
    expect(out.status === 'answered' && out.lostTableIds).toHaveLength(3);
    expect(counted('table', 'malformed')).toBe(3);
  });

  it('charges every claim when the claims themselves are refused', async () => {
    const { heartbeatTables } = await import('./tableLease.js');
    // A duplicate never reaches the database; the module refuses it outright
    // and still declares both claims lost.
    const out = await heartbeatTables([
      { tableId: T1, leaseGeneration: GEN },
      { tableId: T1, leaseGeneration: GEN },
    ]);

    expect(out.status === 'answered' && out.lostTableIds).toHaveLength(2);
    expect(counted('table', 'malformed')).toBe(2);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('a tournament answer nobody can read still accounts for every claim', () => {
  it('charges one malformed outcome per claim when the row set is short', async () => {
    const { heartbeatTournaments } = await import('./tournamentLease.js');
    rpc.mockResolvedValue({
      data: [{ tournament_id: T1, state: 'kept', lease_generation: GEN }],
      error: null,
    });

    const out = await heartbeatTournaments([
      { tournamentId: T1, leaseGeneration: GEN },
      { tournamentId: T2, leaseGeneration: GEN },
    ]);

    expect(out.status).toBe('answered');
    expect(out.status === 'answered' && out.lostTournamentIds).toHaveLength(2);
    expect(counted('tournament', 'malformed')).toBe(2);
  });
});

describe('the identity holds on the ordinary path, and only there', () => {
  it('charges exactly one outcome per claim when the answer is readable', async () => {
    const { heartbeatTables } = await import('./tableLease.js');
    rpc.mockResolvedValue({
      data: [
        { table_id: T1, state: 'kept', lease_generation: GEN },
        { table_id: T2, state: 'taken', lease_generation: GEN },
      ],
      error: null,
    });

    await heartbeatTables([
      { tableId: T1, leaseGeneration: GEN },
      { tableId: T2, leaseGeneration: GEN },
    ]);

    expect(counted('table', 'kept')).toBe(1);
    expect(counted('table', 'taken')).toBe(1);
    expect(counted('table', 'malformed')).toBe(0);
  });

  it('counts nothing for a transport failure, which answers no claim at all', async () => {
    const { heartbeatTables } = await import('./tableLease.js');
    rpc.mockResolvedValue({ data: null, error: { message: 'connection reset' } });

    const out = await heartbeatTables([{ tableId: T1, leaseGeneration: GEN }]);

    // UNKNOWN extends nothing and fences nobody, so no claim earned an outcome.
    expect(out.status).toBe('uncertain');
    expect(counted('table', 'malformed')).toBe(0);
    expect(inc).not.toHaveBeenCalled();
  });
});
