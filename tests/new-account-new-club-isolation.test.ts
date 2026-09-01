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

  it('keeps automated house liquidity out of user-owned club boards', () => {
    expect(recurring).toContain(
      'const isHouseBoard = tournament.club_id === this.houseOwner.clubId'
    );
    expect(recurring).toContain('!== this.houseOwner.clubId');
    expect(recurring).toContain('return 0;');
  });
});
