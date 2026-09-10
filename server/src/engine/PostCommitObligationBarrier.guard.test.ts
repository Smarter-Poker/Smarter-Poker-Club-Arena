import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { sliceMethod } from '../testHelpers/sourceWindow.js';

const read = (file: string): string => readFileSync(join(process.cwd(), file), 'utf8');
const settlement = read('src/engine/ServerTableEngineSettlement.ts');
const handHistory = read('src/services/supabase/handHistory.ts');
const projection = read('src/services/supabase/handProjection.ts');
const migration = read(
  '../supabase/migrations/20260908043400_post_commit_obligations_are_atomic_and_resumable.sql'
);

describe('an accepted hand cannot outrun its durable post-commit obligations', () => {
  const postHand = sliceMethod(settlement, 'protected async postHandTasks(');

  it('binds one immutable obligation envelope to exact lease authority and accepted facts', () => {
    expect(postHand).toContain('const settlementLeaseAuthority = this.getEngineLeaseAuthority();');
    expect(postHand).toContain(
      'const durablePostCommitObligations = settlementLeaseAuthority?.verified === true;'
    );
    expect(postHand).toContain('const acceptedPostCommitFacts = durablePostCommitObligations');
    expect(postHand).toContain('const postCommitObligations = durablePostCommitObligations');
    expect(postHand).toContain('leaseGeneration: leaseAuthority.generation');
    expect(postHand).toContain('postCommitObligations,');
    expect(postHand).toContain('acceptedPostCommitFacts,');

    const writer = sliceMethod(handHistory, 'async function insertHandHistoryRow(');
    expect(writer).toContain('p_post_commit_obligations: atomicCommit.postCommitObligations!');
    expect(writer).toContain('_accepted_post_commit_facts: atomicCommit.acceptedPostCommitFacts');
    expect(writer).toContain('atomicCommit.assertLeaseAuthority?.();');
    expect(writer).toContain('result.post_commit_obligations !== true');
  });

  it('terminates an uncommitted generation before any later settlement step can run', () => {
    const refusal = postHand.indexOf('if (!authoritativeCommitSucceeded)');
    const durableBarrier = postHand.indexOf('let postCommitStateCanReflect');
    const laterRake = postHand.indexOf("runStep('rake_distribution'");
    expect(refusal).toBeGreaterThan(-1);
    expect(postHand.slice(refusal, durableBarrier)).toContain(
      "this.killForRestart('authoritative_hand_commit_not_proved')"
    );
    expect(postHand.slice(refusal, durableBarrier)).toContain('throw new Error(');
    expect(durableBarrier).toBeGreaterThan(refusal);
    expect(laterRake).toBeGreaterThan(durableBarrier);
  });

  it('keeps a committed hand behind an unbounded causal barrier until completion or lease loss', () => {
    const barrier = postHand.slice(
      postHand.indexOf('if (durablePostCommitObligations && v_handHistoryId)'),
      postHand.indexOf("runStep('rake_distribution'")
    );
    expect(barrier).toContain('while (!obligationsApplied && this.lifecycleCanMutate())');
    expect(barrier).toContain('await processHandPostCommitObligations(v_handHistoryId)');
    expect(barrier).toContain('if (!obligationsApplied)');
    expect(barrier).toContain('return;');
    expect(barrier).toContain('post_commit_stack_refresh_failed');
    expect(barrier).not.toMatch(/attempt\s*[<>]=?\s*\d+[^\n]*break/);
    expect(barrier).not.toContain('void processHandPostCommitObligations');
    /* 2026-09-08: the envelope resolves the frozen add-ons silently (the RPC
       returns a count). What it did is announced from HERE - the bubble, the
       private adjustment frame, the cap-cache rebuild - after the stack
       refresh, with the receipt's own count. Delete this call and every
       other suite stays green while the announcement is dead on production;
       that is the defect this pin exists for. */
    expect(barrier).toContain('outcome.pending_addons');
    expect(barrier).toContain(
      'await this.announceEnvelopeResolvedAddOns(v_handHistoryId, players, resolvedAddOnCount)'
    );
  });

  it('never applies a protocol-2 pending add-on through the legacy engine path', () => {
    const pending = postHand.slice(
      postHand.indexOf("runStep('pending_addons'"),
      postHand.indexOf("runStep('horse_rebuys'")
    );
    expect(pending).toContain('if (!durablePostCommitObligations && !this.isTournamentTable())');
    expect(pending).toContain('await this.processPendingAddOns(players)');
    expect(pending).toContain('if (!this.lifecycleCanMutate()) return;');
  });

  it('fences every later awaited stage before another local or durable mutation', () => {
    for (const step of [
      'rake_distribution',
      'bbj_contribution',
      'promo_playthrough',
      'insurance_ledger',
      'bbj_mini_payout',
      'bbj_payout',
      'pending_addons',
      'horse_rebuys',
      'chip_continuity',
      'horse_cashouts',
      'deferred_sitouts',
      'leave_pending',
      'table_unlock',
    ]) {
      const start = postHand.indexOf(`runStep('${step}'`);
      expect(start, `${step} must exist`).toBeGreaterThan(-1);
      const next = postHand.indexOf("runStep('", start + 10);
      const window = postHand.slice(start, next < 0 ? undefined : next);
      expect(window, `${step} must end behind a lease fence`).toContain(
        'if (!this.lifecycleCanMutate()) return;'
      );
    }
  });
});

describe('the database owns exactly-once obligation completion', () => {
  it('stores request and frozen-payload hashes in the accepted-hand transaction', () => {
    expect(migration).toContain('post_commit_request_hash');
    expect(migration).toContain('post_commit_payload_hash');
    expect(migration).toContain('post_commit_payload_conflict');
    expect(migration).toContain("'{pending_addons,ids}'");
    expect(migration).toContain('a.created_at <= transaction_timestamp()');
    expect(migration).toContain('time_bank_uses_remaining');
    expect(migration.indexOf('time_bank_uses_remaining')).toBeLessThan(
      migration.indexOf('SET post_commit_payload = v_payload')
    );
  });

  it('serializes by table and completes every additive leg with one receipt', () => {
    expect(migration).toContain("pg_advisory_xact_lock(\n    hashtextextended('hand-post-commit:'");
    expect(migration).toContain('FOR UPDATE;');
    expect(migration).toContain('predecessor_pending');
    expect(migration).toContain('post_commit_completed_at = clock_timestamp()');
    expect(migration).toContain('atomic_distribute_rake(');
    expect(migration).toContain('promo_apply_playthrough(');
    expect(migration).toContain('bbj_record_contribution(');
    expect(migration).toContain('record_insurance_transaction(');
    expect(migration).toContain('resolve_pending_addon(');
  });

  it('matches downstream insurance uniqueness and has no polling substitute', () => {
    expect(migration).toContain("SELECT count(DISTINCT x->>'player_id')");
    expect(migration).not.toMatch(/cron\.schedule|pg_cron|setInterval/i);
    // 2026-09-10: the worker gained ONE interval, a 5 s wake-up net under the
    // LISTEN/Realtime signal paths. It is not a substitute for the causal
    // retry: it stands down while a drain runs or a retry is armed, so a
    // failed durable row is still owned by its bounded retry chain.
    expect(projection.match(/setInterval\s*\(/g)).toHaveLength(1);
    // The poll yields to a running drain and to an armed retry (pollIsDue),
    // and the retry itself is still what a failed row owns.
    expect(projection).toContain('drainRunning: drainPromise !== null,');
    expect(projection).toContain('retryArmed: retryTimer !== null,');
    expect(projection).toContain('causalRetryOwed = summary.failed > 0 || summary.deferred > 0');
    expect(migration).toContain('BEFORE DELETE ON public.hand_projection_outbox');
  });

  it('keeps the processor private to the engine role and trigger owner', () => {
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.fn_ca_process_hand_post_commit_obligations(uuid)\n  FROM PUBLIC, anon, authenticated;'
    );
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.fn_ca_process_hand_post_commit_obligations(uuid)\n  TO service_role;'
    );
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.trg_finish_hand_post_commit_obligations()\n  FROM PUBLIC, anon, authenticated, service_role;'
    );
  });
});
