/**
 * AN ABANDONED RENEWAL PASS NAMES THE HALF THAT NEVER CAME BACK.
 *
 * `performOwnedEngineLeaseProofRenewal` awaits two halves, and each of those
 * awaits exactly one RPC - the cash heartbeat and the tournament heartbeat. So
 * the half still outstanding when a pass is abandoned identifies the call that
 * hung, with nothing left to rule out afterwards.
 *
 * On 2026-09-12 that question cost hours: the renewal loop stopped for four and
 * a half hours, every cash table died on its twenty second proof, and telling a
 * hung pass from a departed loop took a hand-diff of `pg_stat_statements`
 * against the container log, because the process said nothing either way.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';

type Renewer = {
  ownershipLeaseRenewalOperation: Promise<void> | null;
  ownershipLeaseRenewalCompletedAtMs: number;
  ownershipLeaseRenewalOutstanding: { cash: boolean; tournament: boolean } | null;
  performOwnedEngineLeaseProofRenewal: () => Promise<void>;
  renewOwnedEngineLeaseProofs: () => Promise<void>;
};

async function buildRenewer(pass: () => Promise<void>): Promise<Renewer> {
  process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-placeholder-key';
  const { GameServer } = await import('./GameServer.js');
  return Object.assign(Object.create(GameServer.prototype), {
    ownershipLeaseRenewalOperation: null,
    ownershipLeaseRenewalCompletedAtMs: Date.now(),
    ownershipLeaseRenewalOutstanding: null,
    performOwnedEngineLeaseProofRenewal: pass,
  }) as Renewer;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** The reported reason, captured from the console.error reportError writes. */
async function abandonReason(
  outstanding: { cash: boolean; tournament: boolean } | null
): Promise<string> {
  vi.useFakeTimers();
  const errs: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    errs.push(a.map((x) => (x instanceof Error ? x.message : String(x))).join(' '));
  });
  const server = await buildRenewer(() => new Promise<void>(() => {}));
  void server.renewOwnedEngineLeaseProofs();
  // The real pass sets this; the stub above cannot, so place it directly.
  server.ownershipLeaseRenewalOutstanding = outstanding;
  await vi.advanceTimersByTimeAsync(21_000);
  return errs.join('\n');
}

describe('an abandoned renewal pass names the half that hung', () => {
  it('names cash when only the cash heartbeat is still out', async () => {
    const reason = await abandonReason({ cash: true, tournament: false });
    expect(reason).toContain('Still outstanding: cash');
    expect(reason).not.toContain('tournament');
  });

  it('names tournament when only the tournament heartbeat is still out', async () => {
    const reason = await abandonReason({ cash: false, tournament: true });
    expect(reason).toContain('Still outstanding: tournament');
  });

  it('names both when neither came back', async () => {
    const reason = await abandonReason({ cash: true, tournament: true });
    expect(reason).toContain('Still outstanding: cash and tournament');
  });

  it('says so plainly when the pass settled as the timer fired', async () => {
    const reason = await abandonReason({ cash: false, tournament: false });
    expect(reason).toContain('neither half');
  });

  it('a REJECTED half has come back and is not blamed', async () => {
    // `finally` and not `then` is what makes this true - the distinction the
    // whole diagnostic rests on.
    process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-placeholder-key';
    const { GameServer } = await import('./GameServer.js');
    const outstanding = { cash: true, tournament: true };
    const server = Object.assign(Object.create(GameServer.prototype), {
      ownershipLeaseRenewalOutstanding: null,
      renewVerifiedCashTableLeaseProofs: () => Promise.reject(new Error('rpc blew up')),
      renewVerifiedTournamentManagerLeaseProofs: () => new Promise(() => {}),
    }) as unknown as Renewer & { ownershipLeaseRenewalOutstanding: typeof outstanding | null };

    void server.performOwnedEngineLeaseProofRenewal();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(server.ownershipLeaseRenewalOutstanding?.cash, 'a rejected half has returned').toBe(
      false
    );
    expect(server.ownershipLeaseRenewalOutstanding?.tournament).toBe(true);
  });
});
