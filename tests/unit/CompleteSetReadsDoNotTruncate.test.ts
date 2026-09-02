/**
 * A READ WHOSE PURPOSE IS "ALL OF THEM" MUST NOT STOP AT A NUMBER.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-27: "there should never be a cap on the amount of players in the
 * club, union or anywhere else."
 *
 * These specific reads were TRUNCATING PRODUCTION when this was written:
 *
 *   ClubDetailPage member list   .limit(500) against SHARK CLUB's 590 members
 *                                and Club JAQK's 584 - so 90 and 84 members
 *                                were absent from their own club's member
 *                                list, with nothing on screen saying the list
 *                                was short. It was ORDERED by created_at,
 *                                which made the invisible ones reliably the
 *                                NEWEST joiners: the members most likely to
 *                                be looked for.
 *
 * and these were latent, waiting on growth:
 *
 *   StatsExport                  .limit(5000) - a roster export a club owner
 *                                would trust, silently short past 5,000.
 *   AgentAssignmentPanel         .limit(2000) - a member missing from the
 *                                roster reads as "does not exist".
 *   AgentPromoPanel              .limit(1000) - a player who can never be
 *                                sent a promo.
 *   admin.ts union club lookup   .limit(100) on an AUTHORIZATION path - a
 *                                union admin of club #101 would be DENIED.
 *   TournamentResults myEntries  .limit(5000) of a player's own history.
 *
 * The guard is deliberately narrow: it names the reads whose contract is the
 * complete set. Honest UI paging - a search dropdown at .limit(10), a 4-seat
 * table preview - is correct and is NOT covered here, because deleting a
 * limit is not automatically an improvement.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sliceCall } from '../helpers/sourceWindow';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
/** Strip comments so prose about the old ceilings cannot satisfy a pin. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const COMPLETE_SET_READS: Array<[string, string]> = [
  ['src/components/admin/StatsExport.tsx', 'club roster export'],
  ['src/components/agent/AgentPromoPanel.tsx', 'players an agent can promo'],
  ['src/components/agent/AgentAssignmentPanel.tsx', 'club roster for agent assignment'],
  ['src/pages/ClubDetailPage.tsx', 'club member list'],
  ['src/pages/FriendsPage.tsx', 'complete bidirectional friend network'],
];

describe('complete-set reads page instead of capping', () => {
  it.each(COMPLETE_SET_READS)('%s (%s) uses fetchAllRows', (file) => {
    expect(code(read(file))).toMatch(/fetchAllRows\s*[<(]/);
  });

  it('the club member list no longer stops at 500 — two live clubs exceeded it', () => {
    const src = code(read('src/pages/ClubDetailPage.tsx'));
    expect(src).not.toMatch(/\.limit\(500\)/);
  });

  it('the ROSTER export pages — the member list is a complete set', () => {
    // Scoped to the roster read specifically. The OTHER export in this file
    // (the caller's own hands) keeps a deliberate scope limit, pinned below.
    const src = code(read('src/components/admin/StatsExport.tsx'));
    const roster = src.slice(src.indexOf('fetchMemberStats'), src.indexOf('fetchOwnHands'));
    expect(roster).toMatch(/fetchAllRows\s*[<(]/);
    expect(roster).not.toMatch(/\.limit\(/);
  });

  it('the HAND export keeps its scope limit, and now admits to it', () => {
    /* This one must NOT be "fixed" by paging. Every table id rides in the
       query string of the next request and ~1000 uuids is a 37 KB URL that
       servers answer 414 — the cap is a protocol constraint, not an
       oversight. The defect was silence: a club with 36,403 tables got an
       export scoped to 200 of them and a toast reporting a row count that
       read as complete. It is named, measured against, and surfaced now. */
    const src = code(read('src/components/admin/StatsExport.tsx'));
    expect(src).toMatch(/const CLUB_TABLE_SCAN_LIMIT = 200;/);
    expect(src).toMatch(/handScopeWasClipped\.current =/);
    expect(src).toMatch(/Older Hands Are Not In This File/);
  });

  it('the agent panels no longer stop at 1000 / 2000', () => {
    expect(code(read('src/components/agent/AgentPromoPanel.tsx'))).not.toMatch(/\.limit\(1000\)/);
    expect(code(read('src/components/agent/AgentAssignmentPanel.tsx'))).not.toMatch(
      /\.limit\(2000\)/
    );
  });

  it('the friend network no longer stops at 200 edges in either direction', () => {
    const src = code(read('src/pages/FriendsPage.tsx'));
    expect(src).not.toMatch(/\.limit\((?:100|200)\)/);
    expect(src).toContain('FriendsPage.accepted_sent');
    expect(src).toContain('FriendsPage.accepted_received');
    expect(src).toContain('FriendsPage.pending_received');
  });

  it("a player's own tournament history is not capped at 5000", () => {
    /* PIN MOVED (2026-08-29, round 12): the mechanism changed, the invariant
       did not. The page no longer fetches the player's complete entry set
       at all - the Mine filter is an inner join, so the newest 100 completed
       events THE PLAYER WAS IN come back in one query and no entry can age
       past a client-side cap because there is no client-side set. What this
       pin now guards is that the join is really there and the capped scan
       cannot come back. */
    const src = code(read('src/pages/tournament/TournamentResultsPage.tsx'));
    expect(src).toMatch(/tournament_players!inner\(user_id\)/);
    expect(src).toMatch(/eq\('tournament_players\.user_id', user\.id\)/);
    expect(src).not.toMatch(/\.limit\(5000\)/);
  });
});

describe('paged complete-set reads stay ordered', () => {
  // Paging an UNORDERED query lets Postgres serve a row twice or skip it
  // between pages - the defect the club_members house rule exists for.
  it.each(COMPLETE_SET_READS.filter(([file]) => file !== 'src/pages/FriendsPage.tsx'))(
    '%s orders its paged query',
    (file) => {
      const src = code(read(file));
      const idx = src.search(/fetchAllRows\s*[<(]/);
      expect(idx, 'expected a fetchAllRows call').toBeGreaterThan(-1);
      // The factory body follows the call; it must contain an .order() before
      // its .range().
      const body = sliceCall(src.slice(idx), 'fetchAllRows');
      expect(body).toMatch(/\.order\(/);
      expect(body).toMatch(/\.range\(/);
    }
  );

  it('the three friend-network directions are each ordered before their range', () => {
    const src = code(read('src/pages/FriendsPage.tsx'));
    const queryBodies = [
      src.slice(
        src.indexOf('FriendsPage.accepted_sent'),
        src.indexOf('FriendsPage.accepted_received')
      ),
      src.slice(
        src.indexOf('FriendsPage.accepted_received'),
        src.indexOf('FriendsPage.pending_received')
      ),
      src.slice(src.indexOf('FriendsPage.pending_received'), src.indexOf('const sentFriendIds')),
    ];
    for (const query of queryBodies) {
      expect(query.indexOf('.order(')).toBeGreaterThan(-1);
      expect(query.indexOf('.range(')).toBeGreaterThan(query.indexOf('.order('));
    }
  });
});
