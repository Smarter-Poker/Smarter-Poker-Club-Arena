/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A RETRY THAT CANNOT RUN IS NOT A RETRY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS (2026-09-12)
 *
 * `aDatabaseThatAsksToBeRetriedIsRetried` gave `hand_history` a retry budget
 * and taught `isTransientDbError` to recognise a serialization failure. Both
 * were right and neither could fire, because of the ORDER the two things
 * happen in:
 *
 *   1. the `hand_history` step body catches the refusal and calls
 *      `killForRestart(...)`, which sets `terminal = true; running = false`
 *      SYNCHRONOUSLY, then rethrows;
 *   2. `runStep` catches that throw and decides whether to retry. Its third
 *      condition is `!this.lifecycleCanMutate()`, and `lifecycleCanMutate()`
 *      returns `this.running && !this.terminal && ...`.
 *
 * So step 1 guaranteed step 2 would refuse. The budget was spent before it
 * could be used: attempt 1 killed the engine, and attempt 2 was declined
 * because the engine was dead. A retry that is unreachable is not a retry.
 *
 * ── WHAT PRODUCTION LOOKED LIKE ───────────────────────────────────────────
 *
 * From 10:04:25Z on 2026-09-12, `engine_recovery_events` recorded, per
 * killed table and in this fixed order:
 *
 *     authoritative_hand_semantic_refusal      (the cause)
 *     authoritative_hand_commit_not_proved     (+0.3-1.5s)
 *     post_hand_settlement_failed              (+0.3-1.5s, racing it)
 *
 * 1,021 of the 1,023 refusals in that window carried one error:
 *
 *     atomic hand commit refused (atomic_hand_rolled_back):
 *     F06_RETRY_CANONICAL_LANE
 *
 * `smarter_private.f06_try_lane` raises that with ERRCODE 40001 when it
 * cannot take an advisory lane, BEFORE doing any work - so the transaction
 * wrote nothing, which is why a re-run is a re-run and not a replay. Checked
 * on production: of 930 refused (table_id, hand_number) pairs, ZERO had a
 * `hand_atomic_commits` row and ZERO had a `hand_history` row. No money
 * moved. What was lost was the hand.
 *
 * ── WHAT THIS LAW DOES NOT DO ─────────────────────────────────────────────
 *
 * It does not make a refusal survivable. When the budget really is exhausted
 * the throw still reaches `await lanes.record`, `authoritativeCommitSucceeded`
 * is still false, and `authoritative_hand_commit_not_proved` still kills the
 * generation - which is right: the loop must not deal from seats the database
 * never accepted. It only stops the kill happening BEFORE the question is
 * asked.
 *
 * And it does not widen what may be retried. A refusal is eligible only when
 * the database said it rolled the whole hand back AND the cause is the one
 * Postgres defines as "run it again". A conservation violation, a negative
 * stack, a constraint, a fractional stack and an expired lease proof all stay
 * terminal on the first throw; the last cases here pin that.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ServerTableEngineBase } from './ServerTableEngineBase.js';

const rolledBack = (e: unknown) =>
  (
    ServerTableEngineBase as unknown as {
      isRolledBackSerializationRefusal: (e: unknown) => boolean;
    }
  ).isRolledBackSerializationRefusal(e);

const settlement = () => readFileSync(join(__dirname, 'ServerTableEngineSettlement.ts'), 'utf8');
const base = () => readFileSync(join(__dirname, 'ServerTableEngineBase.ts'), 'utf8');

describe('the refusal the database asked us to run again', () => {
  it('recognises both reasons production actually returns', () => {
    // 971 of these, and 50 of the second, between 10:00 and 11:35Z.
    expect(
      rolledBack(
        new Error('atomic hand commit refused (atomic_hand_rolled_back): F06_RETRY_CANONICAL_LANE')
      )
    ).toBe(true);
    expect(
      rolledBack(new Error('atomic hand commit refused (rolled_back): F06_RETRY_CANONICAL_LANE'))
    ).toBe(true);
  });

  it('recognises a rolled-back hand by SQLSTATE when the sentinel is absent', () => {
    expect(
      rolledBack(
        Object.assign(new Error('atomic hand commit refused (atomic_hand_rolled_back): conflict'), {
          code: '40001',
        })
      )
    ).toBe(true);
  });

  it('needs BOTH halves: a rollback whose cause is a decision stays terminal', () => {
    // The reason says "rolled back", but the cause is the engine submitting a
    // hand that does not add up. Another identical attempt cannot fix that.
    for (const msg of [
      'atomic hand commit refused (atomic_hand_rolled_back): conservation violation: delta 0.01',
      'atomic hand commit refused (atomic_hand_rolled_back): negative stack for 9f2c',
      'atomic hand commit refused (rolled_back): duplicate key value violates unique constraint',
      'atomic hand commit refused (atomic_hand_rolled_back): accepted tournament hand produced fractional stack 12.5 for 9f2c',
    ]) {
      expect(rolledBack(new Error(msg)), msg).toBe(false);
    }
  });

  it('does not touch the refusals that were never a rollback', () => {
    for (const msg of [
      'atomic hand commit refused (lease_proof_expired)',
      'atomic hand commit refused (missing_commit_receipt)',
      'atomic hand commit refused (post_commit_rake_club_mismatch)',
      'atomic hand commit refused (receipt_identity_mismatch)',
      'atomic hand commit refused (tournament_stack_proof_invalid)',
    ]) {
      expect(rolledBack(new Error(msg)), msg).toBe(false);
    }
  });

  it('a bare serialization failure is not a hand commit rollback', () => {
    // isTransientDbError already owns this one. Widening THIS predicate to it
    // would let it speak for refusals it has no receipt for.
    expect(rolledBack(Object.assign(new Error('deadlock detected'), { code: '40001' }))).toBe(
      false
    );
  });
});

describe('the kill does not pre-empt the retry budget', () => {
  it('the guarded throw comes before killForRestart in the commit catch', () => {
    const src = settlement();
    const guard = src.indexOf('ServerTableEngineBase.isRolledBackSerializationRefusal(err)');
    const kill = src.search(
      /this\.killForRestart\(\s*semantic \? 'authoritative_hand_semantic_refusal'/
    );
    expect(
      guard,
      'the commit catch must ask whether the database asked to be retried'
    ).toBeGreaterThan(-1);
    expect(kill, 'the semantic/transport kill must still exist for real refusals').toBeGreaterThan(
      -1
    );
    expect(
      guard < kill,
      'the retryable-refusal guard must be reached BEFORE killForRestart: the kill ' +
        'is synchronous and makes lifecycleCanMutate() false, which is the exact ' +
        'condition runStep uses to refuse the retry.'
    ).toBe(true);
  });

  it('the guard leaves without killing, alerting, or a terminal loop phase', () => {
    const src = settlement();
    const from = src.indexOf('ServerTableEngineBase.isRolledBackSerializationRefusal(err)');
    const block = src.slice(from, src.indexOf('const semantic = message.includes(', from));
    expect(block).toContain('throw err;');
    expect(block).not.toContain('killForRestart');
    expect(block).not.toContain('raiseFinancialAlert');
    expect(block).not.toContain('settlement_fault');
  });

  it('killForRestart is still synchronous, which is why the order matters', () => {
    const src = base();
    const body = src.slice(src.indexOf('protected killForRestart('));
    const terminal = body.indexOf('this.terminal = true;');
    expect(terminal, 'killForRestart must still fence synchronously').toBeGreaterThan(-1);
    expect(terminal).toBeLessThan(body.indexOf('signalRestartRequired'));
    expect(src).toMatch(/lifecycleCanMutate\(\)[\s\S]{0,400}!this\.terminal/);
  });

  it('runStep still refuses to retry a dead generation', () => {
    // Not a bug - it is correct, and it is the reason this law exists. The
    // fix is that nothing kills the generation before this question is asked.
    const src = settlement();
    const budget = src.indexOf('if (attempts > budget)');
    const transient = src.indexOf('if (!ServerTableEngineBase.isTransientDbError(err))', budget);
    const lifecycle = src.indexOf('const retryAllowed = this.lifecycleCanMutate();', transient);
    expect(budget).toBeGreaterThan(-1);
    expect(transient).toBeGreaterThan(budget);
    expect(lifecycle).toBeGreaterThan(transient);
    expect(src.slice(budget, transient)).toContain('throw err;');
    expect(src.slice(transient, lifecycle)).toContain('throw err;');
    expect(src.slice(lifecycle, src.indexOf('await this.sleep', lifecycle))).toMatch(
      /if \(!retryAllowed\) \{[\s\S]*throw err;/
    );
  });

  it('an exhausted budget still kills, and still alerts', () => {
    const src = settlement();
    expect(src).toContain("this.killForRestart('authoritative_hand_commit_not_proved');");
    expect(src).toContain('`postHandTasks.${stepName}_failed`');
  });
});
