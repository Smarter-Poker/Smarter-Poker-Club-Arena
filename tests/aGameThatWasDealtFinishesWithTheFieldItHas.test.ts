/**
 * A GAME THAT WAS DEALT FINISHES WITH THE FIELD IT HAS (2026-09-11).
 *
 * Forty games dealt on 2026-09-08 between 12:49 and 14:53 UTC lost their engine
 * at the :53 break before the RUNNING commit and sat in REGISTERING for three
 * days, decided, with 2,164.60 chips of finalized prize pools unpaid. Two
 * things held them there, and this file pins both of them shut.
 *
 * THE ENGINE never offered them. `GameServer`'s start gate has two arms, and
 * both count a field that has not played yet: `seatFirstReady` wants every seat
 * sold, `timeReached` wants `current_players >= min_players`. A game that has
 * BEEN PLAYED has neither, because its field has shrunk to the survivor.
 * Measured on the forty: seventeen at 1 of 2, twenty-two at 1-2 of 3, one MTT
 * at 2 of 4. Not one satisfied either arm. The comment above the gate said the
 * gate recovered exactly this case; it never did.
 *
 * THE DATABASE would have refused anyway. `fn_complete_tournament_launch_*`
 * proved the roster as it would be at a launch, and counted a correctly closed
 * table as a broken one.
 *
 * The division of labour is the part worth keeping: the engine PROPOSES a row
 * that looks finished, and the database DECIDES on evidence it holds - hands
 * dealt, the receipt's own moment, entrant statuses, seats. If this file ever
 * has to change because the engine started deciding from a counter, that is
 * the regression.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sliceEnclosingBlock, sliceStatement } from './helpers/sourceWindow';

const read = (p: string): string => readFileSync(resolve(process.cwd(), p), 'utf8');

const gameServer = read('server/src/GameServer.ts');
const migration = read(
  'supabase/migrations/20260911173003_a_game_that_was_dealt_finishes_with_the_field_it_has.sql'
);

describe('the engine offers a dealt game to the launch completion', () => {
  it('the start gate has an arm for a game that has already dealt', () => {
    const gate = sliceStatement(gameServer, 'const shouldStart =');
    expect(gate).toContain('finishingADealtGame');
    // The two original arms are untouched: a fresh game still starts the way
    // it always did.
    expect(gate).toContain('seatFirstReady');
    expect(gate).toContain('maxReached || timeReached');
  });

  it('that arm is about the pool and the clock, never about a counter', () => {
    const arm = sliceStatement(gameServer, 'const finishingADealtGame =');
    expect(arm).toContain('poolFinalized');
    expect(arm).toContain('isPastStart');
    expect(arm).toContain('FINALIZED_FINISH_RETRY_MS');
    // current_players and min_players are exactly the numbers that were wrong
    // about these rows. The engine must not read them here.
    expect(arm).not.toContain('current_players');
    expect(arm).not.toContain('minPlayers');
    expect(arm).not.toContain('paidSeats');
  });

  it('a refusal is a stable answer, so the offer is throttled and the clock is pruned', () => {
    expect(gameServer).toContain('const FINALIZED_FINISH_RETRY_MS = 5 * 60_000;');
    expect(gameServer).toContain('private finalizedFinishAttempt: Map<string, number>');
    const prune = sliceEnclosingBlock(gameServer, 'this.finalizedFinishAttempt.delete(id)');
    expect(prune).toContain('stillRegistering');
  });
});

describe('the database decides, on evidence it holds', () => {
  it('the recovery proof requires a game that actually dealt', () => {
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.fn_prove_played_launch_recovery'
    );
    for (const refusal of [
      'no_hand_was_dealt',
      'the_receipt_is_not_the_deal_that_happened',
      'an_entrant_was_never_dealt_in',
      'the_field_that_was_dealt_is_short',
      'the_surviving_field_is_not_seated',
      'pool_not_finalized',
    ]) {
      expect(migration).toContain(refusal);
    }
  });

  it('the receipt must name the moment of the first hand, so evidence cannot be borrowed', () => {
    expect(migration).toContain('v_first_hand IS DISTINCT FROM p_started_at');
    expect(migration).toContain('p_started_at IS NULL OR');
  });

  it('the completion accepts the surviving field only when that proof passes', () => {
    expect(migration).toContain('v_required_field := v_active_count;');
    expect(migration).toContain('public.fn_prove_played_launch_recovery(');
    // The narrow spin escape it generalises is still there.
    expect(migration).toContain('fn_prove_played_spin_launch_recovery');
  });

  it('a closed table is history, and an event with no live table still cannot pass', () => {
    expect(migration).toContain("AND t.status <> 'closed'");
    expect(migration).toContain('v_live_table_count < 1');
  });

  it('none of the admission cores is reachable from a browser', () => {
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.fn_prove_played_launch_recovery(uuid, timestamptz)'
    );
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.fn_complete_tournament_launch_before_lease_generation(uuid, uuid)'
    );
  });

  it('is one transaction, per the production DDL policy', () => {
    expect(migration.match(/^BEGIN;$/gm)?.length).toBe(1);
    expect(migration.match(/^COMMIT;$/gm)?.length).toBe(1);
  });
});
