import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..');
const membershipMigration = readFileSync(
  resolve(root, 'supabase/migrations/20260901090000_club_card_human_realtime_stats.sql'),
  'utf8'
);
const openingBankMigration = readFileSync(
  resolve(root, 'supabase/migrations/20260901075500_repair_pre_trigger_opening_bank.sql'),
  'utf8'
);
const signupMigration = readFileSync(
  resolve(
    root,
    'supabase/migrations/20260429o_x35_signup_trigger_creates_wallet_plus_backfill.sql'
  ),
  'utf8'
);
const recurring = readFileSync(
  resolve(root, 'server/src/services/TournamentRecurringService.ts'),
  'utf8'
);

describe('New account and new club isolation', () => {
  it('starts a new account wallet at zero', () => {
    expect(signupMigration).toMatch(/VALUES\s*\(NEW\.id,\s*'PLAYER',\s*0,\s*0\)/);
  });

  it('starts each standalone club with the promised 100,000-chip bank', () => {
    expect(openingBankMigration).toContain('NEW.chip_treasury := 100000');
    expect(openingBankMigration).toContain("'club-opening-grant:' || NEW.id::text");
  });

  it('allows membership creation only through Join A Club or atomic owner creation', () => {
    expect(membershipMigration).toContain("v_source NOT IN ('join_club', 'club_owner_create')");
    expect(membershipMigration).toContain('trg_club_members_require_explicit_join');
  });

  it('keeps foreign liquidity out of user-owned club boards via the club-scoped pick', () => {
    /**
     * The old mechanism was REFUSAL: topUpWithHorses returned 0 for any
     * non-house tournament. Once activated clubs got their own seat-first
     * boards (2026-09-01) that stranded every one of them at seats-1 —
     * a Deep Stack heads-up opened with its one horse, the human window
     * closed, and the forbidden top-up left 1/2-paid duels REGISTERING
     * forever. The isolation now lives in the PICK: candidates are
     * restricted to the tournament's own club members
     * (clubMemberIdsForTournament inside pickFreeHorses and
     * registerHorses), so house horses still never reach a user club's
     * table — a club with no member horses gets nobody, exactly as
     * isolated as before.
     */
    expect(recurring).toContain('MEMBERSHIP IS THE BOUNDARY, NOT THE HOUSE');
    expect(recurring).toContain('this.pickFreeHorses(poolWanted, false, tournamentId)');
    expect(recurring).toContain('clubMemberIdsForTournament');
    // The held-empty rule still applies only to house boards at creation.
    expect(recurring).toContain(
      'const isHouseBoard = tournament.club_id === this.houseOwner.clubId'
    );
  });
});
