/**
 * A HORSE PLAYS ONLY IN THE CLUB IT BELONGS TO.
 *
 * Dan, 2026-09-01: "IT CAN NOT, WANDER... THEY ARE LIMITED TO ONLY THE CLUB
 * THEY ARE APART OF!"
 *
 * Cash was already safe, and not by accident of this file: atomic_table_buyin
 * debits club_members.chip_balance, so a horse with no membership row in the
 * table's club cannot buy in at all. Measured on the live floor - 94 seated
 * horses, zero of them seated in a club they are not a member of.
 *
 * TOURNAMENTS WERE NOT, AND #2430 ONLY CLOSED HALF OF IT. registerHorses
 * selected every is_horse profile on the platform and never looked at the
 * tournament's club; that path is now scoped. But every SEAT-FIRST format --
 * Spins, Heads-Up, SNGs, and the past-start top-up -- fills through
 * pickFreeHorses instead, which read the same platform-wide fleet and had no
 * club filter at all. Measured after #2430 merged: 173 open seats held by a
 * standalone club's horses in another club's games, every one of them on a
 * tournament table.
 *
 * Both doors are now held to the rule a human is already held to: you cannot
 * play in a club's game without being a member of that club.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'src/services/TournamentRecurringService.ts'), 'utf8');

const HELPER = SRC.slice(
  SRC.indexOf('private async clubMemberIdsForTournament'),
  SRC.indexOf('private async pickFreeHorses')
);

describe('the club membership read', () => {
  it('is one implementation, not one per caller', () => {
    expect(HELPER.length).toBeGreaterThan(0);
    // The inline copy #2430 left inside registerHorses is gone.
    expect(SRC.match(/const hostClub = await supabase/g)?.length ?? 0).toBe(1);
  });

  it('reads the club that actually hosts the tournament', () => {
    expect(HELPER).toMatch(/const hostClub = await supabase\s*\.from\('tournaments'\)/);
    expect(HELPER).toMatch(
      /const hostClubId = \(hostClub\.data as \{ club_id\?: string \} \| null\)\?\.club_id;/
    );
  });

  it('loads that club members, paged, so a big club cannot be truncated', () => {
    expect(HELPER).toContain("from('club_members')");
    expect(HELPER).toContain("eq('club_id', hostClubId)");
    expect(HELPER).toContain('fetchAllRows');
    expect(HELPER).toContain("idKey: 'user_id'");
  });

  /**
   * FAILS OPEN on an unreadable page, like every other gate in this file. A
   * partial read is not an empty club, and refusing on a failed read would
   * starve every board on the platform - the shape of the bug that emptied the
   * cash floor for forty minutes on 2026-08-31. null means "no opinion", and
   * both callers are written to skip filtering on null.
   */
  it('returns null rather than an empty club when it cannot answer', () => {
    expect(HELPER).toMatch(/if \(!hostClubId\) return null;/);
    expect(HELPER).toMatch(/if \(!memberPage\.complete\) return null;/);
  });
});

describe('horses register only into their own club', () => {
  it('drops a non-member from the registration pool', () => {
    expect(SRC).toMatch(
      /if \(clubMemberIds && !clubMemberIds\.has\(h\.id\)\) \{\s*clubDropped\+\+;\s*return false;\s*\}/
    );
  });

  it('still selects only available horses, and still drops the busy and the wrong lane', () => {
    expect(SRC).toContain("eq('horse_status', 'available')");
    expect(SRC).toMatch(/busyDropped\+\+/);
    expect(SRC).toMatch(/laneDropped\+\+/);
  });
});

describe('seat-first games are filled from their own club', () => {
  const PICK = SRC.slice(
    SRC.indexOf('private async pickFreeHorses'),
    SRC.indexOf('const candidates = selectHorseCandidates')
  );

  it('pickFreeHorses accepts the tournament it is filling', () => {
    expect(PICK).toMatch(/tournamentId\?: string/);
  });

  /**
   * THE GUARD ITSELF. The fleet read is every horse on the platform; the
   * candidate list handed to selectHorseCandidates must be the club's subset.
   * A filter computed and then not applied is decoration.
   */
  it('narrows the platform fleet to the host club before selecting', () => {
    expect(PICK).toMatch(
      /const clubIds = tournamentId \? await this\.clubMemberIdsForTournament\(tournamentId\) : null;/
    );
    expect(PICK).toMatch(
      /const inClub = clubIds \? fleetIds\.filter\(\(id\) => clubIds\.has\(id\)\) : fleetIds;/
    );
    expect(SRC).toMatch(/selectHorseCandidates\(\s*inClub,/);
  });

  /**
   * BOTH CALLERS, NOT ONE. The opening fill and the top-up are separate paths
   * to the same seats; scoping only one leaves the other wandering.
   */
  it('the opening fill passes its tournament', () => {
    expect(SRC).toContain('await this.pickFreeHorses(opening, false, tournament.id)');
  });

  it('the top-up fill passes its tournament', () => {
    expect(SRC).toMatch(/await this\.pickFreeHorses\(poolWanted, false, tournamentId\)/);
  });

  it('leaves the pool alone when the club cannot be resolved', () => {
    expect(PICK).toMatch(/: fleetIds;/);
  });
});
