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
 * TOURNAMENTS WERE NOT. registerHorses selected every is_horse profile on the
 * platform and never looked at the tournament's club, so any horse could be
 * entered into any club's event. A 416-horse population built for a standalone
 * club took 729 seats in another club's tournaments within seven hours -
 * freerolls and paid events both - while never being a member there.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'src/services/TournamentRecurringService.ts'), 'utf8');

describe('horses register only into their own club', () => {
  it('reads the club that actually hosts the tournament', () => {
    expect(SRC).toMatch(/const hostClub = await supabase\s*\.from\('tournaments'\)/);
    expect(SRC).toMatch(
      /const hostClubId = \(hostClub\.data as \{ club_id\?: string \} \| null\)\?\.club_id;/
    );
  });

  it('loads that club members, paged, so a big club cannot be truncated', () => {
    const block = SRC.slice(
      SRC.indexOf('let clubMemberIds'),
      SRC.indexOf('const eligible = poolAll.filter')
    );
    expect(block).toContain("from('club_members')");
    expect(block).toContain("eq('club_id', hostClubId)");
    expect(block).toContain('fetchAllRows');
    expect(block).toContain("idKey: 'user_id'");
  });

  /**
   * THE GUARD ITSELF. A non-member must be dropped from the pool, not merely
   * counted - a filter that tallies and returns nothing is decoration.
   */
  it('drops a non-member from the candidate pool', () => {
    expect(SRC).toMatch(
      /if \(clubMemberIds && !clubMemberIds\.has\(h\.id\)\) \{\s*clubDropped\+\+;\s*return false;\s*\}/
    );
  });

  /**
   * FAILS OPEN on an unreadable page, like every other gate in this file. A
   * partial read is not an empty club, and refusing on a failed read would
   * starve every event on the platform - the shape of the bug that emptied the
   * cash floor for forty minutes on 2026-08-31.
   */
  it('leaves the pool alone when the membership read is incomplete', () => {
    expect(SRC).toMatch(/if \(memberPage\.complete\) clubMemberIds = new Set/);
    // null means "no opinion", and the filter is written to skip on null.
    expect(SRC).toMatch(/let clubMemberIds: Set<string> \| null = null;/);
    expect(SRC).toMatch(/if \(clubMemberIds && /);
  });

  it('still selects only available horses, and still drops the busy and the wrong lane', () => {
    expect(SRC).toContain("eq('horse_status', 'available')");
    expect(SRC).toMatch(/busyDropped\+\+/);
    expect(SRC).toMatch(/laneDropped\+\+/);
  });
});
