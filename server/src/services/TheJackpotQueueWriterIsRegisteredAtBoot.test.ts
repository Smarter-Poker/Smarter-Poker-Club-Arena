/**
 * THE JACKPOT QUEUE WRITER IS REGISTERED, NOT MERELY WRITTEN
 * ═══════════════════════════════════════════════════════════════════════════
 * BBJ build plan phase 1 verification, 2026-09-06.
 *
 * `processBBJPayout` queues an unpayable jackpot through a writer that
 * `FeeReconciler` installs with a MODULE-SCOPE side effect
 * (`setBBJPayoutQueueWriter(queueUnpaidBBJPayout)`). Nothing anywhere proved
 * that side effect actually runs in the engine.
 *
 * That is the whole failure mode this queue exists to prevent, one level up:
 * if the import chain into FeeReconciler is ever dropped, tree-shaken, or made
 * lazy, `bbjPayoutQueueWriter` stays null and a detected-but-unpayable jackpot
 * leaves NO durable record - only a Sentry alert, which is exactly the
 * "somebody has to notice by hand" state the 2026-09-04 audit was written
 * about. Every unit test in BBJPayoutIsPaidOrQueued installs its own stub
 * writer, so all of them pass with the real registration deleted.
 *
 * These pins are therefore about WIRING:
 *   1. importing FeeReconciler (what boot does) installs a real writer, proven
 *      by driving a payout to exhaustion and watching the row be inserted;
 *   2. the engine's boot path actually imports FeeReconciler.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const rpc = vi.fn();
const from = vi.fn();
vi.mock('./supabase.js', () => ({
  supabase: { rpc: (...a: unknown[]) => rpc(...a), from: (...a: unknown[]) => from(...a) },
  logBBJCollection: vi.fn(),
}));
vi.mock('./supabase/client.js', () => ({
  supabase: { rpc: (...a: unknown[]) => rpc(...a), from: (...a: unknown[]) => from(...a) },
}));
vi.mock('./errorReporter.js', () => ({ reportError: vi.fn() }));
vi.mock('./financialAlerts.js', () => ({
  raiseFinancialAlert: vi.fn().mockResolvedValue({ persisted: true, alertId: 'a' }),
}));

// Importing FeeReconciler is what the engine's boot does. Its module body runs
// setBBJPayoutQueueWriter. Nothing here calls that function by hand.
import './FeeReconciler.js';
import { processBBJPayout } from './supabase/bbj.js';

const POOL = 'f9806a7f-e7a2-47d2-a676-36336e3a5337';
const PARAMS = {
  tableId: 'c5c742e5-c29d-41e0-94c2-e56ec7b2d2cd',
  clubId: 'fade0000-0000-0000-0000-000000000001',
  handNumber: 6237804,
  loserUserId: 'bad-beat-holder',
  winnerUserId: 'hand-winner',
  loserHandName: 'Full House',
  winnerHandName: 'Four of a Kind',
  dealtInPlayerIds: ['bad-beat-holder', 'hand-winner', 'p3'],
  seatedUserIds: ['bad-beat-holder', 'hand-winner', 'p3'],
  payoutTotalPercent: 25,
};

let queued: Array<Record<string, unknown>>;

function chain(result: { data: unknown; error: unknown }) {
  const c: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'is', 'order', 'limit']) c[m] = () => c;
  c.maybeSingle = () => Promise.resolve(result);
  c.then = (res: (v: unknown) => void) => res(result);
  return c;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  queued = [];
  from.mockImplementation((name: string) => {
    if (name === 'clubs') return chain({ data: { union_id: 'union-1' }, error: null });
    if (name === 'bbj_pools')
      return chain({ data: { id: POOL, main_balance: 100_000, backup_balance: 0 }, error: null });
    if (name === 'hand_history') return chain({ data: { id: 'hand-1' }, error: null });
    if (name === 'pending_fee_distributions') {
      return {
        insert: (row: Record<string, unknown>) => {
          queued.push(row);
          return Promise.resolve({ error: null });
        },
      };
    }
    return chain({ data: null, error: null });
  });
  // Every attempt fails transiently, so the payout exhausts and must queue.
  rpc.mockResolvedValue({ data: null, error: { message: 'fetch failed' } });
});

describe('importing FeeReconciler installs the real queue writer', () => {
  it('an unpayable jackpot is durably queued without any test stubbing the writer', async () => {
    const p = processBBJPayout(PARAMS);
    for (let i = 0; i < 8; i++) await vi.runAllTimersAsync();
    expect(await p).toBeNull();

    // THE PIN: a row exists because the module-scope registration ran.
    expect(queued).toHaveLength(1);
    const row = queued[0];
    expect(row.kind).toBe('bbj_payout');
    expect(row.table_id).toBe(PARAMS.tableId);
    expect(row.hand_number).toBe(PARAMS.handNumber);
    expect(row.hand_id).toBe('hand-1');
    // The parameter set a human (or the reconciler) needs to re-drive it.
    expect(row.contributions).toMatchObject({
      loserUserId: 'bad-beat-holder',
      winnerUserId: 'hand-winner',
      payoutTotalPercent: 25,
      dealtInPlayerIds: PARAMS.dealtInPlayerIds,
    });
    // No fee is at stake here - the pool's money is.
    expect(row.rake).toBe(0);
    expect(row.bbj).toBe(0);
  });
});

describe('the engine boot path reaches that registration', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const read = (p: string) => readFileSync(resolve(here, p), 'utf8');

  it('GameServer imports FeeReconciler, so the side effect runs on boot', () => {
    expect(read('../GameServer.ts')).toMatch(/from '\.\/services\/FeeReconciler\.js'/);
  });

  it('index.ts boots GameServer', () => {
    expect(read('../index.ts')).toMatch(/from '\.\/GameServer\.js'/);
  });

  it('FeeReconciler registers at module scope, not inside a function', () => {
    const src = read('./FeeReconciler.ts');
    // A bare call at column 0 is module scope; indented would be inside something.
    expect(src).toMatch(/^setBBJPayoutQueueWriter\(queueUnpaidBBJPayout\);$/m);
  });
});
