/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A HAND NAMES ITSELF BEFORE IT BANKS ITS RAKE
 *  CLAUDE.md 10.11 (fix it at the root) + 10.12 (a repair job is not a fix)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THE DEFECT THIS PINS, measured on production 2026-09-07 over 24 hours of
 * live cash play.
 *
 * `hand_history.id` defaults to `gen_random_uuid()`, so the hand's identity
 * used to be decided by the INSERT. Settlement writes the hand first and banks
 * the rake second precisely so it can pass that id along - but the insert can
 * fail or simply be slow (measured the same day: 143 of 11,485 hands in two
 * hours landed more than 30 seconds after `ended_at`, 66 of them more than two
 * minutes, worst 252 seconds), and then the hand goes to the in-process retry
 * queue and settlement carries on with `null`.
 *
 * A null hand id is not a cosmetic gap. It cost three separate things:
 *
 *  1. NOBODY EARNED. `atomic_distribute_rake` writes `rake_attributions` only
 *     `IF v_first_claim AND p_hand_id IS NOT NULL`. 173 cash hands in 24 hours
 *     were banked with a null id and ZERO of them had a single attribution row
 *     - no VIP points, no agent or super-agent commission, no rakeback basis,
 *     for every player at the table, horse and human alike (CLAUDE.md 10.5).
 *
 *  2. THE UNIQUE INDEX WAS OFF. `uq_rake_records_hand_id` is
 *     `UNIQUE (hand_id) WHERE hand_id IS NOT NULL`, so it deduped nothing and
 *     an in-line retry after a lost response booked the club again. 36 hands
 *     in seven days carried two or three copies of their own rake row.
 *
 *  3. THE CLUB WAS PAID TWICE. `v_leg_key` is
 *     `COALESCE(p_hand_id, md5('rake:'||table||':'||hand_number))`, so the live
 *     call (null id) and the 15-minute re-drive (real id) took DIFFERENT leg
 *     keys, `rake_distribution_legs` could not dedupe them, and `club_wallets`
 *     was incremented twice. 384 hands 2026-09-02 to 2026-09-07 were booked a
 *     second time; of those, the 99 with BOTH leg rows on record - the ones
 *     where the double credit can be PROVEN rather than inferred - carry
 *     166.38 chips of rake and 26.18 of BBJ drop that no pot ever paid. That
 *     is the figure `20260907200330` corrected, because the wider 719.49 is
 *     what the earlier rows would have cost if `rake_distribution_legs` had
 *     existed to record them, and a number you cannot read is not a number you
 *     settle (CLAUDE.md 10.86).
 *
 * THE FIX, and what this law protects: settlement MINTS the uuid itself before
 * anything is written, and hands the same value to the `hand_history` insert,
 * to `atomic_distribute_rake`, and to the BBJ contribution. The row then lands
 * under that id in line, or from the queue five minutes later, or never - and
 * the booking names the same hand in all three cases.
 *
 * Every assertion below is one of the four ways this has regressed or could:
 * reading the id back out of the response, passing the post-insert variable to
 * the money path, or letting either fee call fall back to null.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const here = new URL('.', import.meta.url).pathname;
const settlement = readFileSync(join(here, 'ServerTableEngineSettlement.ts'), 'utf8');
const handHistory = readFileSync(
  join(here, '..', 'services', 'supabase', 'handHistory.ts'),
  'utf8'
);

describe('the hand mints its own id at settlement', () => {
  it('settlement imports randomUUID and mints one id per hand', () => {
    expect(settlement).toMatch(/import \{ randomUUID \} from 'node:crypto';/);
    expect(settlement).toMatch(/const v_handId = randomUUID\(\);/);
  });

  it('mints it BEFORE the hand_history step, not after the insert answers', () => {
    const mint = settlement.indexOf('const v_handId = randomUUID();');
    const step = settlement.indexOf("await runStep('hand_history'");
    const readBack = settlement.indexOf('v_handHistoryId = result.handId;');
    expect(mint).toBeGreaterThan(-1);
    expect(step).toBeGreaterThan(-1);
    expect(readBack).toBeGreaterThan(-1);
    expect(mint).toBeLessThan(step);
    expect(mint).toBeLessThan(readBack);
  });

  it('hands that id to logHandHistory so the row lands under it', () => {
    expect(settlement).toMatch(/handId: v_handId,/);
  });

  it('keeps v_handHistoryId meaning "the row is in the database"', () => {
    // It must still be initialised null and still be what the broadcast,
    // the award-unit ledger and the integrity feed read - those three need
    // the ROW, not just the identity.
    expect(settlement).toMatch(/let v_handHistoryId: string \| null = null;/);
    expect(settlement).toMatch(/if \(v_handHistoryId && this\.lifecycleCanMutate\(\)\) \{/);
    expect(settlement).toMatch(/hand_id: v_handHistoryId,/); // hand_history_saved
  });
});

describe('the money path never takes an id that might be null', () => {
  it('atomic_distribute_rake is called with the minted id', () => {
    expect(settlement).toMatch(/p_hand_id: v_handId,/);
    expect(settlement).not.toMatch(/p_hand_id: v_handHistoryId/);
  });

  it('the unbanked-rake queue entry carries the minted id', () => {
    const rakeStep = settlement.slice(
      settlement.indexOf("runStep('rake_distribution'"),
      settlement.indexOf("runStep('bbj_contribution'")
    );
    expect(rakeStep).toMatch(/handId: v_handId,/);
    expect(rakeStep).not.toMatch(/handId: v_handHistoryId/);
  });

  it('the BBJ contribution names the hand too - this is the root of bbj_unlinkable', () => {
    const bbjStep = settlement.slice(settlement.indexOf("runStep('bbj_contribution'"));
    expect(bbjStep).toMatch(/v_handId\s*\n?\s*\);/);
    expect(bbjStep.slice(0, bbjStep.indexOf('lastError'))).not.toMatch(/v_handHistoryId/);
  });
});

describe('logHandHistory honours the minted id', () => {
  it('accepts one, and writes it as the row id', () => {
    expect(handHistory).toMatch(/handId\?: string;/);
    expect(handHistory).toMatch(/\.\.\.\(params\.handId \? \{ id: params\.handId \} : \{\}\)/);
  });

  it('omits `id` entirely when no caller minted one, so the default still applies', () => {
    // The spread form above is what makes this true; a plain `id: params.handId`
    // would write an explicit null and every non-settlement caller would break.
    expect(handHistory).not.toMatch(/^\s*id: params\.handId,\s*$/m);
  });

  it('returns the minted id when the insert lands but the response body does not', () => {
    // "the write succeeded and we could not read the answer" must not be
    // indistinguishable from "the write failed" - that is how the null got in.
    expect(handHistory).toMatch(/const minted = typeof row\.id === 'string' \? row\.id : null;/);
    expect(handHistory).toMatch(
      /return \{ id: data\?\.id \?\? minted, wroteUnits: false, settlementCommitted: true \};/
    );
    expect(handHistory).toMatch(/wroteUnits: true,[\s\S]*?settlementCommitted: true/);
    expect(handHistory).not.toMatch(/return \{ id: data\?\.id \?\? null/);
  });

  it('treats a duplicate-key answer as the same good news', () => {
    const dupes = handHistory.match(
      /if \(existing \|\| minted\)\s*return \{ id: existing \?\? minted, wroteUnits: false, settlementCommitted: true \};/g
    );
    expect(dupes).toHaveLength(2); // the plain insert and the bomb-pot RPC
  });
});

describe('the repair stays a net, and is not asked to be the fix', () => {
  it('nothing rebuilds attribution from columns on hand_history', () => {
    // 20260907192843 added player_contributions / returned_uncalled /
    // rake_method to hand_history so the hourly repair could attribute what it
    // re-banked. 20260907195116 dropped them again: with the id minted the
    // repair cannot fire, and 1.3 GB a month to feed a job that must never run
    // is the band-aid 10.12 forbids. If these names come back on the engine
    // side, the root fix has been abandoned for the plaster again.
    expect(settlement).not.toMatch(/player_contributions/);
    expect(handHistory).not.toMatch(/player_contributions/);
  });
});
