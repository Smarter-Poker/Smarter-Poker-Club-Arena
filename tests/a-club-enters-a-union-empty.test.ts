/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A CLUB ENTERS A UNION EMPTY, AND THE DEFAULT-MINTED THOUSANDS ARE GONE
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-08-26, binding, verbatim:
 *
 *   "ONCE A CLUB JOINS A UNION, THEY NEED TO START WITH ZERO CHIPS, AND THE
 *    CHIPS THEY RECEIVE ARE FUNDED FROM THE UNION ONLY."
 *
 *   "clubs must downline there player and agents balances before moving to the
 *    union. they must remove any and all chips balances from all players and
 *    agents before moving to the union, then once accepted, reload all the
 *    balances with chips from inside the union."
 *
 *   "REMOVE ALL THE FIX EXISTING ROWS CONTAINING THE 1000 CHIPS."
 *
 * THE ORDER IS THE DESIGN. The club settles up first, under its own control.
 * The join is then refused until the club is genuinely empty. Nothing reaches
 * in and zeroes a player's wallet on the club's behalf: a rule that
 * confiscates 48 million chips as a side effect of an admin clicking "join" is
 * not a rule, it is an incident.
 *
 * WHAT WAS ALREADY THERE. The "funded by the union only" half is Dan's own rule
 * from 2026-08-22 and was already enforced: fn_mint_club_chips and
 * fn_mint_chips_from_diamonds both refuse a club whose clubs.union_id is set.
 * This adds the missing half - that it walks in at zero - and does not
 * duplicate the mint guard.
 *
 * WHERE THE GUARD SITS. On union_clubs INSERT, because that table is the
 * authoritative membership record and trg_union_clubs_sync_mirror is what
 * copies it onto clubs.union_id. Every path into a union goes through it,
 * including screens nobody has written yet.
 *
 * FORWARD ONLY, on Dan's instruction: JAQK and SHARK are already in Midway
 * Union holding 1,051,817.71 and 1,476,644.87, and an INSERT trigger never
 * re-validates them.
 *
 * PROVED against production inside a transaction that rolled itself back: a
 * probe club holding 500 chips was REFUSED with an itemised breakdown
 * ("treasury 500.00, ... Total 500.00"); the same club, emptied, joined. Zero
 * probe rows survived and the two real memberships were untouched.
 *
 * THE THOUSANDS. Five rows still held the balance the old
 * club_members.chip_balance DEFAULT 1000 minted from nothing - runbabyrun and
 * dan@smarter.poker in SHARK, minhloc73gr in all three clubs. Burned, not
 * transferred: chips that were never funded have no source to return to, and
 * moving them into a treasury would relabel the same unbacked thousand as
 * settled. Each burn is on file as a 'default_mint_correction' row in
 * chip_transactions so reconciliation sees money leave instead of finding a gap.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');

const UNION_GUARD = read('supabase/migrations/20260826_a_club_enters_a_union_empty.sql');
const BURN = read('supabase/migrations/20260826_burn_the_default_minted_thousands.sql');

describe('the union join guard', () => {
  it('fires on union_clubs INSERT, the authoritative membership record', () => {
    expect(UNION_GUARD).toMatch(/CREATE TRIGGER trg_club_enters_a_union_empty/);
    expect(UNION_GUARD).toMatch(/BEFORE INSERT ON public\.union_clubs/);
  });

  it('counts every place a chip can hide, not just the treasury', () => {
    for (const line of [
      'club_treasury',
      'club_promo',
      'member_wallets',
      'horse_wallets',
      'agent_wallets',
      'chips_on_felt',
      'bbj_pool',
    ]) {
      expect(UNION_GUARD).toMatch(new RegExp(`'${line}'`));
    }
    // held and locked chips count too - a balance that is merely reserved is
    // still a balance the union would inherit.
    expect(UNION_GUARD).toMatch(/COALESCE\(cm\.held_chips,0\)/);
    expect(UNION_GUARD).toMatch(/COALESCE\(cm\.locked_chips,0\)/);
  });

  it('refuses rather than zeroing anything itself', () => {
    // The club settles its own players. This must never become a wipe.
    expect(UNION_GUARD).toMatch(/This club still holds chips and cannot join a union yet/);
    const executable = UNION_GUARD.slice(UNION_GUARD.indexOf('CREATE OR REPLACE FUNCTION'));
    expect(executable).not.toMatch(/UPDATE club_members\s+SET chip_balance = 0/);
  });

  it('tells the owner exactly what is left, in the refusal itself', () => {
    expect(UNION_GUARD).toMatch(/DETAIL\s*=\s*format\(/);
    expect(UNION_GUARD).toMatch(/HINT\s*=/);
  });

  it('exposes the same breakdown as a callable, so a screen can show it first', () => {
    expect(UNION_GUARD).toMatch(/FUNCTION public\.fn_club_union_join_blockers\(p_club_id uuid\)/);
    expect(UNION_GUARD).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_club_union_join_blockers\(uuid\) TO authenticated/
    );
  });

  it('lets a union house club through, since it is not joining itself', () => {
    expect(UNION_GUARD).toMatch(/IF NEW\.club_id = NEW\.union_id THEN/);
  });

  it('asserts against a club it knows is not empty', () => {
    // A blocker that reports everything empty would pass silently and let a
    // loaded club walk in. It is checked against SHARK CLUB on apply.
    expect(UNION_GUARD).toMatch(/blocker reports SHARK CLUB empty, which cannot be true/);
  });
});

describe('the club creation grant', () => {
  it('is 100,000 and still lands in the founder wallet', () => {
    expect(UNION_GUARD).toMatch(/VALUES \(NEW\.user_id, NEW\.club_id, 100000\)/);
    expect(UNION_GUARD).toMatch(/chip_balance = COALESCE\(chip_balance, 0\) \+ 100000/);
  });
});

describe('the burned default-minted thousands', () => {
  it('only touches a balance that is untouched in every sense', () => {
    // A balance that reached 1000 through real play is not this bug.
    expect(BURN).toMatch(/chip_balance = 1000/);
    expect(BURN).toMatch(/COALESCE\(cm\.hands_played, 0\) = 0/);
    expect(BURN).toMatch(/COALESCE\(cm\.held_chips, 0\) = 0/);
    expect(BURN).toMatch(/COALESCE\(cm\.locked_chips, 0\) = 0/);
  });

  it('writes every burn to the ledger so reconciliation sees it leave', () => {
    expect(BURN).toMatch(/INSERT INTO chip_transactions/);
    expect(BURN).toMatch(/'default_mint_correction'/);
  });

  it('stops instead of running if the mint has come back at scale', () => {
    expect(BURN).toMatch(/expected a handful of default-minted rows, found % - stop and look/);
  });

  it('asserts nothing was left behind', () => {
    expect(BURN).toMatch(/still % default-minted rows holding 1000/);
  });
});
