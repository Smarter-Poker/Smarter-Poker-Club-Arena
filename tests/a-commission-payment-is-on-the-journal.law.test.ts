/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A COMMISSION PAYMENT IS TWO LEGS ON THE JOURNAL (2026-09-08)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Phase 8 of 8 of the union accounting programme: Control. Phase 6 deferred it
 * by name - "a full journal (every wallet movement as two balanced legs with a
 * trial balance) ... belongs in Phase 8 (Control) next to
 * approve-before-execute, where a journal has a reader."
 *
 * WHAT WAS TRUE ON PRODUCTION BEFORE THIS LAW, measured 2026-09-08:
 *
 *   - fn_union_weekly_rakeback_close (round 1) wrote a keyed chip_ledger leg
 *     and asserted conservation on the balances themselves.
 *   - fn_settle_round2_club_to_agents debited through fn_debit_treasury, which
 *     writes a ONE-SIDED chip_transactions row, and credited by UPDATE-ing
 *     club_members.chip_balance directly with a ONE-SIDED wallet_transactions
 *     row. It carried the comment "Both sides of the entry" over two rows in
 *     two unrelated tables that no reader can pair.
 *   - fn_agent_claim_commission UPDATEd clubs.chip_treasury and
 *     club_members.chip_balance directly plus one chip_transactions row.
 *   - The only commission legs in chip_ledger were 78 legs / 117.92 written on
 *     2026-03-24. Commission had been off the journal since March.
 *
 * fn_ca_trial_balance compares, per account, balance movement against the net
 * of the journal's legs, and it already carried both accounts this money
 * crosses (club_treasuries, player_wallets). A payer that moves the balances
 * and writes no leg is therefore drift BY CONSTRUCTION - the same shape
 * CLAUDE.md 11.5 records for atomic_table_buyin, where writing
 * club_members.chip_balance directly made 48 chips invisible.
 *
 * Nothing had leaked yet, which is the only reason this is a law and not an
 * incident: chip_transactions held ZERO 'commission_claim' rows and
 * agent_commission_settlements was empty, while 1,008,323.53 sat owed. The
 * first union close would have moved about a million chips past the journal.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

const MIGRATION = read(
  'supabase/migrations/20260908113416_a_commission_payment_is_two_legs_on_the_journal.sql'
);
/** Part 2 of the same sweep: the third payer. */
const ROUND3 = read('supabase/migrations/20260908121659_round_3_is_on_the_journal_too.sql');

/** The leg each payer gains, as the migration splices it in. */
const round2Leg = MIGRATION.slice(
  MIGRATION.indexOf('$migrate_round2$'),
  MIGRATION.indexOf('$migrate_claim$')
);
const claimLeg = MIGRATION.slice(
  MIGRATION.indexOf('$migrate_claim$'),
  MIGRATION.indexOf('$assert$')
);

describe('both commission payers write a journal leg', () => {
  it('round 2 posts to chip_ledger', () => {
    expect(round2Leg).toMatch(/INSERT INTO public\.chip_ledger/);
  });

  it('the agent claim posts to chip_ledger', () => {
    expect(claimLeg).toMatch(/INSERT INTO public\.chip_ledger/);
  });

  it('each leg crosses the two accounts the trial balance already watches', () => {
    // club_treasury is clubs.chip_treasury; player_wallet is
    // club_members.chip_balance, which the supply snapshot calls member_wallets
    // and fn_ca_trial_balance reports as player_wallets. Naming any other pair
    // would post a leg the reader cannot reconcile.
    for (const leg of [round2Leg, claimLeg]) {
      expect(leg).toMatch(/'club_treasury'/);
      expect(leg).toMatch(/'player_wallet'/);
    }
  });

  it('one category for one kind of money', () => {
    // The vocabulary also has 'agent_claim', but round 2 and the claim are the
    // same economic event through two doors. A reader asking what an agent has
    // been paid should not have to know both words; which door paid is in the
    // description and the idempotency key.
    for (const leg of [round2Leg, claimLeg]) {
      expect(leg).toMatch(/'commission'/);
    }
  });
});

describe('a replay cannot post the same payment twice', () => {
  it('round 2 keys its leg by union, period, club and agent', () => {
    expect(round2Leg).toMatch(/'round2:'/);
    expect(round2Leg).toMatch(/idempotency_key/);
    expect(round2Leg).toMatch(/ON CONFLICT DO NOTHING/);
  });

  it('the claim keys its leg by the op id it is already idempotent on', () => {
    expect(claimLeg).toMatch(/'agent_claim:'/);
    expect(claimLeg).toMatch(/ON CONFLICT DO NOTHING/);
  });
});

describe('the rewrite refuses to guess', () => {
  it('each payer is transformed on an anchor asserted to appear exactly once', () => {
    // These are 5.2K and 12.5K of live money code. The migration splices one
    // INSERT beside a unique anchor rather than retyping a payout by hand, and
    // aborts if the anchor is missing or ambiguous.
    expect(MIGRATION).toMatch(/anchor expected exactly once, found %/);
    expect(
      MIGRATION.match(/v_hits <> 1 THEN/g)?.length,
      'both payers must assert their anchor'
    ).toBe(2);
  });

  it('it is a no-op on a database that already has the legs', () => {
    expect(MIGRATION.match(/already writes a journal leg; nothing to do/g)?.length).toBe(2);
  });

  it('and it asserts the payers kept everything else they did', () => {
    expect(MIGRATION).toMatch(/lost its settlement row or its treasury debit/);
    expect(MIGRATION).toMatch(/lost its settlement row or its transaction record/);
  });
});

describe('round 3 is on the journal too', () => {
  /* Found by sweeping every remaining union money path after the first two
     payers landed. fn_settle_round3_agents_to_players moves the agent's
     club_members.chip_balance to the player's and recorded it in one
     wallet_transactions row. It has run: 559 rows / 43,990.40 on 2026-08-20.

     No reader caught it because BOTH sides are member wallets, which
     fn_ca_trial_balance reports as the single player_wallets account - the
     debit and the credit cancel and the account total never moves. Only
     fn_ca_ledger_replay, which is per account owner, can see it. */
  it('posts the agent-to-player movement to chip_ledger', () => {
    expect(ROUND3).toMatch(/INSERT INTO public\.chip_ledger/);
  });

  it('names member wallets on both sides, because that is what they are', () => {
    const leg = ROUND3.slice(ROUND3.indexOf('$leg$'), ROUND3.lastIndexOf('$leg$'));
    expect(leg).toMatch(/'player_wallet', r\.agent_user, 'player_wallet', r\.player_id/);
  });

  it('is rakeback, not commission, so the two obligations stay apart', () => {
    const leg = ROUND3.slice(ROUND3.indexOf('$leg$'), ROUND3.lastIndexOf('$leg$'));
    expect(leg).toMatch(/'rakeback'/);
    expect(leg).not.toMatch(/'commission'/);
  });

  it('is keyed so a replayed close cannot double-post', () => {
    expect(ROUND3).toMatch(/'round3:'/);
    expect(ROUND3).toMatch(/ON CONFLICT DO NOTHING/);
  });

  it('refuses to guess, and keeps every step round 3 already had', () => {
    expect(ROUND3).toMatch(/anchor expected exactly once, found %/);
    expect(ROUND3).toMatch(/already writes a journal leg; nothing to do/);
    expect(ROUND3).toMatch(/lost a step it had before/);
  });
});
