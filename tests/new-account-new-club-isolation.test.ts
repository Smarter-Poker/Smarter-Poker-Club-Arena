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
    /* ── THE PIN MOVED WITH THE MECHANISM (2026-09-11, CLAUDE.md 5.8) ───────
     *
     * This pinned `const isHouseBoard = tournament.club_id ===
     * this.houseOwner.clubId`, a branch that opened a seat-first board with
     * horses ONLY when the board belonged to the house. It was written when
     * `pickFreeHorses` drew from every `is_horse` profile on the platform,
     * and it was the only thing standing between a new owner enabling Spins
     * and the house fleet enrolling itself in their club.
     *
     * The pool has been CLUB-SCOPED since 2026-09-01: `pickFreeHorses` takes
     * the tournament id and filters the fleet through
     * `clubMemberIdsForTournament` -> `clubMemberIdsForScope`, which is the
     * host club for a standalone event and the union's member clubs for a
     * union event. A club whose membership holds no horses therefore draws an
     * EMPTY pool and its board opens empty - the isolation this case is about,
     * now a property of the pool rather than of a branch.
     *
     * Keeping the branch cost the clubs that DO have horse members: measured
     * live 2026-09-11, 82 of 83 open Deep Stack Society seat-first boards had
     * no seat sold, because only the house branch could seed one. So the
     * branch is gone and this pins what replaced it: the opening draw is
     * scoped to the tournament, and the scope is the club or its union.
     * See docs/changelog/2026-09-11-the-horse-audit.md.
     */
    expect(recurring).toContain('this.pickFreeHorses(opening, false, tournament.id)');
    expect(recurring).toContain('clubMemberIdsForTournament(tournamentId, pass)');
    expect(recurring).toContain(
      'const inClub = clubIds ? fleetIds.filter((id) => clubIds.has(id)) : fleetIds;'
    );
    // And the scope itself: the host club alone, or the union's MEMBER clubs.
    expect(recurring).toContain('clubMemberIdsForScope(hostClubId, unionId)');
  });
});
