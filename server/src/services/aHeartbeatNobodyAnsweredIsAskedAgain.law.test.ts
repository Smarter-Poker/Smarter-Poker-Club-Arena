/**
 * LAW: A HEARTBEAT NOBODY ANSWERED IS ASKED AGAIN (2026-09-26).
 *
 * At 04:45:26 UTC every one of 338 tournament managers lost lease authority at
 * once while every lease row in the database still named this instance and
 * generation. The Supabase logs show why: the one request carrying all 338
 * claims (`POST /rpc/heartbeat_tournament_leases_v4`) waited in PostgREST's
 * pool for its whole 20 s window and came back 504 at 04:45:26.49, and while
 * it was outstanding the retained-batch coordinator refused to ask about those
 * claims again. One unanswered request was the fleet's only question, so
 * "I could not tell" became "I lost it" for everybody (CLAUDE.md 10.86).
 *
 * This drives the real heartbeatTournaments / heartbeatTables with the real
 * retained-batch coordinator exactly as GameServer's renewal pass does - one
 * pass every 5 s, each handing its batch callback and its currency predicates
 * - against a fleet whose members keep authority only while their proof
 * deadline is in the future, the rule TournamentManagerBase and
 * ServerTableEngineBase enforce.
 *
 *   1. The first request of a slow pass hangs past its window and then fails
 *      the way PostgREST did (504). Later requests are answered `kept`. The
 *      fleet must never lapse: nobody is fenced, nobody would be quarantined.
 *   2. The same slow pass, but the database answers that one lease has
 *      really moved to another generation. That manager must stop; every
 *      other manager must keep its lease. Real fencing is not weakened.
 *   3. Every request hangs. Nobody can tell, so nobody may act: the fleet
 *      lapses on its own deadline, and the coordinator never holds more than
 *      three questions per claim at once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.fn();
vi.mock('./supabase/client.js', () => ({
  supabase: { rpc: (...args: unknown[]) => rpc(...args) },
}));

const FLEET = 338;
const PASS_MS = 5_000;
const generation = 'bbbbbbbb-0000-4000-8000-000000000001';
const moved = 'bbbbbbbb-0000-4000-8000-00000000beef';
const id = (index: number) => `aaaaaaaa-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;

type Scope = 'tournament' | 'table';
type Member = { id: string; deadline: number; fenced: boolean; renewed: number };

let now = 0;
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.resetModules();
  rpc.mockReset();
  now = 0;
  delete process.env.ENGINE_PG_LISTEN_URL; // the production configuration on 2026-09-26
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

async function load(scope: Scope) {
  if (scope === 'tournament') {
    const lease = await import('./tournamentLease.js');
    lease._setTournamentLeaseMonotonicNowForTests(() => now);
    return {
      heartbeat: lease.heartbeatTournaments as (...args: any[]) => Promise<any>,
      idKey: 'tournamentId',
      rowKey: 'tournament_id',
      lostKey: 'lostTournamentIds',
    };
  }
  const lease = await import('./tableLease.js');
  lease._setTableLeaseMonotonicNowForTests(() => now);
  return {
    heartbeat: lease.heartbeatTables as (...args: any[]) => Promise<any>,
    idKey: 'tableId',
    rowKey: 'table_id',
    lostKey: 'lostTableIds',
  };
}

/**
 * GameServer's renewal pass, reduced to what decides a lease: dispatch the
 * captured claims with a batch callback, renew on a validated proof, fence on
 * a named loss, and fence whatever the clock has expired.
 */
async function runFleet(
  scope: Scope,
  seconds: number,
  answer: (claims: Array<Record<string, string>>, call: number) => Promise<unknown>
) {
  const { heartbeat, idKey, rowKey, lostKey } = await load(scope);
  let calls = 0;
  rpc.mockImplementation((_name: string, args: { p_claims: Array<Record<string, string>> }) => {
    calls++;
    return answer(args.p_claims, calls);
  });
  const fleet: Member[] = Array.from({ length: FLEET }, (_, index) => ({
    id: id(index),
    deadline: 20_000, // admitted at t=0 with a fresh proof
    fenced: false,
    renewed: 0,
  }));
  const byId = new Map(fleet.map((member) => [member.id, member]));
  const current = (member: Member) => !member.fenced && now < member.deadline;
  const apply = (outcome: any) => {
    if (outcome.status !== 'answered') return;
    for (const proof of outcome.proofs) {
      const member = byId.get(proof[idKey]);
      if (!member || !current(member) || now >= proof.proofDeadlineMonotonicMs) continue;
      member.deadline = Math.max(member.deadline, proof.proofDeadlineMonotonicMs);
      member.renewed++;
    }
    for (const lost of outcome[lostKey]) {
      const member = byId.get(lost);
      if (member) member.fenced = true;
    }
  };
  let maxOutstanding = 0;
  answers.length = 0;
  settled.count = 0;
  for (let t = 0; t <= seconds * 1000; t += 250) {
    now = t;
    deliverDue();
    await flush();
    for (const member of fleet) if (!current(member)) member.fenced = true;
    if (t % PASS_MS === 0) {
      const claims = fleet
        .filter(current)
        .map((member) => ({ [idKey]: member.id, leaseGeneration: generation }));
      if (claims.length) {
        void heartbeat(
          claims,
          apply,
          () => true,
          (claim: Record<string, string>) => {
            const member = byId.get(claim[idKey]);
            return !!member && current(member);
          }
        );
      }
    }
    await flush();
    maxOutstanding = Math.max(maxOutstanding, calls - settled.count);
  }
  return { fleet, calls, maxOutstanding, rowKey };
}

const settled = { count: 0 };
/** Simulated transport: every answer lands at a simulated instant. */
const answers: Array<{ due: number; resolve: (value: unknown) => void; value: () => unknown }> = [];
function after(ms: number, value: () => unknown): Promise<unknown> {
  return new Promise((resolve) => answers.push({ due: now + ms, resolve, value }));
}
function deliverDue() {
  for (const answer of answers.splice(0)) {
    if (answer.due <= now) {
      settled.count++;
      answer.resolve(answer.value());
    } else answers.push(answer);
  }
}
const rows = (claims: Array<Record<string, string>>, rowKey: string, state: (c: any) => object) =>
  claims.map((claim) => ({ [rowKey]: claim[rowKey], ...state(claim) }));

describe.each(['tournament', 'table'] as const)('%s leases', (scope) => {
  const rowKey = scope === 'tournament' ? 'tournament_id' : 'table_id';

  it('a slow pass that never answers does not cost the fleet its leases', async () => {
    const { fleet, calls } = await runFleet(scope, 60, (claims, call) => {
      // 04:45:06 -> 04:45:26: the pass's one request waits out its window
      // and PostgREST answers 504. Every later question gets through.
      if (call === 1) {
        return after(20_500, () => ({
          data: null,
          error: {
            message: 'Timed out acquiring connection from connection pool',
            code: 'PGRST003',
          },
        }));
      }
      return after(300, () => ({
        data: rows(claims, rowKey, () => ({ state: 'kept', lease_generation: generation })),
        error: null,
      }));
    });
    expect(fleet.filter((member) => member.fenced)).toHaveLength(0);
    expect(fleet.every((member) => member.renewed > 0)).toBe(true);
    expect(calls).toBeGreaterThan(1);
  }, 30_000);

  it('a lease the database says moved is still stopped, and only that one', async () => {
    const { fleet } = await runFleet(scope, 60, (claims, call) => {
      if (call === 1) return after(20_500, () => ({ data: null, error: { message: '504' } }));
      return after(300, () => ({
        data: rows(claims, rowKey, (claim) =>
          claim[rowKey] === id(7)
            ? { state: 'taken', lease_generation: moved }
            : { state: 'kept', lease_generation: generation }
        ),
        error: null,
      }));
    });
    expect(fleet.filter((member) => member.fenced).map((member) => member.id)).toEqual([id(7)]);
  }, 30_000);

  it('when nobody can tell, nobody acts, and no claim is asked more than three times at once', async () => {
    const { fleet, maxOutstanding } = await runFleet(scope, 40, () => new Promise(() => {}));
    expect(fleet.every((member) => member.fenced)).toBe(true);
    expect(maxOutstanding).toBeLessThanOrEqual(3);
  }, 30_000);
});
