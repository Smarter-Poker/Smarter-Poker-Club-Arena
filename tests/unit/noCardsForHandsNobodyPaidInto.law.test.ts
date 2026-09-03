/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  LAW: A HAND NOBODY PAID INTO IS NOT RECORDED
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-09-01, verbatim:
 *   "MUCKED HANDS SHOULDN'T BE RECORDED AND TRACKED, ONLY HANDS WHERE THE HERO
 *    PUTS CHIPS IN POT."
 *
 * WHAT WAS HAPPENING. `ca_hand_facts` writes one row per player per hand and
 * stored `hole_cards` on every one, including hands the player was dealt and
 * folded for free. Measured the day of the ruling: 640 of 2,265 rows - 28% -
 * carried the exact holding of a hand nobody put a chip into, and this table is
 * deliberately never pruned.
 *
 * `invested` is the engine's own contributions map, so 0 means no chips of this
 * player's reached the pot at all: not a blind, not an ante.
 *
 * WHERE THE LINE IS, AND WHY. `hand_class` is KEPT. It is the 169-bucket label,
 * carries no suit identity and no board, and it is the DENOMINATOR of the only
 * chart that reads this table: `ca_player_hand_grid`'s default view is "how
 * often you played this hand", computed as hands_vpip / hands per class. Strip
 * the folded-for-free rows and every cell reads 100% - that deletes the feature
 * rather than improving it. That function never selects `hole_cards` at all;
 * only the per-cell drill-down does, and its examples are now hands that were
 * actually played.
 *
 * RULED ON BY DAN, 2026-09-01, when the question was put to him directly:
 * KEEP THE BUCKET LABEL. He was shown all three options - keep it, strip it and
 * build an anonymous tally to replace the denominator, or strip it and lose the
 * chart - and chose to keep it. So the line below is not a compromise somebody
 * settled for, it is the answer. Do not reopen it, and do not "finish the job"
 * by stripping `hand_class`: a rule that fails open is worse than the thing it
 * was guarding against, and nit eviction fails open.
 *
 * TWO ENFORCEMENTS, because one of them can be edited by anybody:
 *   the writer      server/src/services/supabase/handFacts.ts
 *   the database    trg_ca_hand_facts_strip_unpaid_holding
 *
 * The database one NULLS rather than REJECTS on purpose. These rows go in as
 * one batch upsert for the whole table of players, so a CHECK constraint would
 * 400 the entire batch on one offending row and take every other player's stats
 * row with it. Verified against production inside a rolled-back transaction:
 * an explicit write of AhKh onto an unpaid row read back NULL.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { sliceEnclosingBlock } from '../helpers/sourceWindow';

const ROOT = resolve(__dirname, '../..');
const WRITER = readFileSync(resolve(ROOT, 'server/src/services/supabase/handFacts.ts'), 'utf8');
const MIGRATION_NAME = '20260901200000_no_cards_for_hands_nobody_paid_into.sql';
const MIGRATION = readFileSync(resolve(ROOT, 'supabase/migrations', MIGRATION_NAME), 'utf8');

describe('LAW: the cards of a hand nobody paid into are not written', () => {
  it('the writer gates hole_cards on the money, not on the deal', () => {
    const row = sliceEnclosingBlock(WRITER, 'hole_cards:');
    expect(row).toMatch(/hole_cards:\s*invested > 0 \? cards : null/);
    // The old unconditional write must not come back.
    expect(WRITER).not.toMatch(/hole_cards:\s*cards,/);
  });

  it('but hand_class is still written for every dealt hand', () => {
    /* This is the denominator of the hand grid. Gating it on `invested` would
       make every cell of the frequency view read 100%, which is not a stricter
       rule - it is a deleted feature. */
    expect(WRITER).toMatch(/hand_class:\s*cards \? computeHandClass\(cards\) : null/);
    expect(WRITER).not.toMatch(/hand_class:\s*invested > 0/);
  });

  it('and the database enforces it too, so a client regression cannot undo it', () => {
    expect(MIGRATION).toMatch(/CREATE TRIGGER trg_ca_hand_facts_strip_unpaid_holding/);
    expect(MIGRATION).toMatch(/BEFORE INSERT OR UPDATE ON public\.ca_hand_facts/);
    expect(MIGRATION).toMatch(/NEW\.hole_cards := NULL/);
  });

  it('the database enforcement NULLS and never REJECTS', () => {
    /* One batch upsert carries every player at the table. A CHECK constraint
       would 400 the whole batch on one row and lose everybody's stats with it -
       handFacts.ts already records that exact failure mode for another column. */
    expect(MIGRATION).not.toMatch(/ADD CONSTRAINT[\s\S]{0,200}CHECK[\s\S]{0,200}hole_cards/i);
    expect(MIGRATION).toMatch(/NULLS rather than rejects/i);
  });

  it('it also cleaned up what had already been written, and proved it', () => {
    expect(MIGRATION).toMatch(/UPDATE public\.ca_hand_facts[\s\S]{0,200}SET hole_cards = NULL/);
    expect(MIGRATION).toMatch(/backfill left % unpaid holdings behind/);
    // ...and proved the denominator survived the cleanup.
    expect(MIGRATION).toMatch(/the grid denominator is gone/);
  });

  it('the migration is committed under the name the law names', () => {
    /* A migration applied to production but never committed is invisible to
       the next agent and to every schema check. */
    const files = readdirSync(resolve(ROOT, 'supabase/migrations'));
    expect(files).toContain(MIGRATION_NAME);
  });

  it('runs in ONE transaction, per the production DDL policy', () => {
    // Every DDL statement fires a ~28s PostgREST schema reload. Coalesced
    // inside one transaction it is one reload, not three.
    expect(MIGRATION).toMatch(/^BEGIN;/m);
    expect(MIGRATION).toMatch(/^COMMIT;/m);
  });
});
