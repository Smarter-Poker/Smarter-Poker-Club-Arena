import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { blankNonCode, sliceMethod } from '../testHelpers/sourceWindow.js';
import { settleFinalTableDealAtomically } from './atomicFinalTableDeal.js';

const eliminations = readFileSync(
  join(process.cwd(), 'src/tournament/TournamentManagerEliminations.ts'),
  'utf8'
);
const migration = readFileSync(
  join(
    process.cwd(),
    '../supabase/migrations/20260908042500_a_final_table_deal_pays_every_share_or_none.sql'
  ),
  'utf8'
);
const checkDeal = sliceMethod(eliminations, 'checkFinalTableDeal(): Promise<boolean>');
const dealTail = sliceMethod(
  eliminations,
  'settleFinalTableDeal(deal: AtomicFinalTableDealResult): Promise<boolean>'
);

function sqlFunction(source: string, name: string): string {
  const start = source.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`);
  if (start < 0) throw new Error(`SQL function ${name} is missing`);
  const bodyStart = source.indexOf('AS $function$', start);
  const end = source.indexOf('$function$;', bodyStart);
  if (bodyStart < 0 || end < 0) throw new Error(`SQL function ${name} has no complete body`);
  return source.slice(start, end + '$function$;'.length);
}

const atomicDeal = sqlFunction(migration, 'fn_settle_final_table_deal_atomic(');

describe('a final-table deal completes only after the atomic receipt proves completion', () => {
  it.each([
    { ok: false, completed: false, reason: 'escrow_short', retryable: false },
    { ok: true, completed: false, paid: 40, retryable: false },
  ])('rejects an incomplete database receipt: %j', async (receipt) => {
    const rpc = vi.fn(async () => ({ data: receipt, error: null }));

    const result = await settleFinalTableDealAtomically({ rpc }, 'event', {
      maxAttempts: 1,
      retryDelayMs: () => 0,
    });

    expect(result.ok).toBe(false);
    expect(result.completed).toBe(false);
  });

  it.each([0, 100])(
    'accepts explicit COMPLETED, including a replay that moves %s now',
    async (paid) => {
      const rpc = vi.fn(async () => ({
        data: {
          ok: true,
          completed: true,
          already_completed: paid === 0,
          paid,
          players: 2,
          chip_leader: 'first',
          payouts: [
            { user_id: 'first', amount: 100, rank: 1 },
            { user_id: 'second', amount: 100, rank: 2 },
          ],
        },
        error: null,
      }));

      const result = await settleFinalTableDealAtomically({ rpc }, 'event');

      expect(result).toMatchObject({ ok: true, completed: true, paid, players: 2 });
    }
  );

  it('keeps the operational tail behind the explicit receipt guard', () => {
    const atomic = checkDeal.indexOf('settleFinalTableDealAtomically(supabase, this.tournamentId)');
    const proof = checkDeal.indexOf('if (!deal.ok || !deal.completed)', atomic);
    const tail = checkDeal.indexOf('return this.settleFinalTableDeal(deal)', proof);

    expect(atomic).toBeGreaterThanOrEqual(0);
    expect(proof).toBeGreaterThan(atomic);
    expect(tail).toBeGreaterThan(proof);
  });

  it('keeps the post-commit tail free of payment and terminal-state writes', () => {
    const code = blankNonCode(dealTail);

    expect(code).not.toMatch(/settleTournamentObligation|settleFinalTableDealAtomically|\.rpc\(/);
    expect(dealTail).not.toMatch(
      /\.from\('tournaments'\)[\s\S]{0,300}?\.update\(\{[\s\S]{0,200}?status:\s*'COMPLETED'/
    );
    expect(dealTail).toContain('cleanupCommittedTablesAndManager()');
  });
});

describe('deal payout roster validation happens before any settlement', () => {
  it('requires one exact physical table, unique live users and matching seat stacks', () => {
    const tableProof = atomicDeal.indexOf('v_seated_active_tables <> 1');
    const seatCount = atomicDeal.indexOf('v_all_live_seats <> v_live_count', tableProof);
    const uniqueUsers = atomicDeal.indexOf('v_distinct_seat_users <> v_live_count', tableProof);
    const matchingUsers = atomicDeal.indexOf('v_matching_live_users <> v_live_count', tableProof);
    const stackProof = atomicDeal.indexOf('v_seat_stack_mismatches > 0', tableProof);
    const firstPayment = atomicDeal.indexOf(
      'fn_settle_tournament_obligation_before_atomic_batch_gate(',
      stackProof
    );

    expect(tableProof).toBeGreaterThanOrEqual(0);
    expect(seatCount).toBeGreaterThan(tableProof);
    expect(uniqueUsers).toBeGreaterThan(tableProof);
    expect(matchingUsers).toBeGreaterThan(tableProof);
    expect(stackProof).toBeGreaterThan(tableProof);
    expect(firstPayment).toBeGreaterThan(stackProof);
  });

  it('allocates exact cents and rolls every leg back if any share is incomplete', () => {
    const planProof = atomicDeal.indexOf(
      'v_place_total_cents + v_deal_total_cents <> v_pool_cents'
    );
    const transaction = atomicDeal.indexOf('\n  BEGIN', planProof);
    const firstPayment = atomicDeal.indexOf(
      'fn_settle_tournament_obligation_before_atomic_batch_gate(',
      transaction
    );
    const partialProof = atomicDeal.indexOf(
      'atomic final-table-deal leg partially settled',
      firstPayment
    );
    const complete = atomicDeal.indexOf("SET status = 'COMPLETED'", partialProof);
    const rollback = atomicDeal.indexOf('EXCEPTION WHEN OTHERS', complete);

    expect(planProof).toBeGreaterThanOrEqual(0);
    expect(transaction).toBeGreaterThan(planProof);
    expect(firstPayment).toBeGreaterThan(transaction);
    expect(partialProof).toBeGreaterThan(firstPayment);
    expect(complete).toBeGreaterThan(partialProof);
    expect(rollback).toBeGreaterThan(complete);
    expect(atomicDeal.slice(rollback)).toContain("'paid', 0, 'completed', false");
  });
});
