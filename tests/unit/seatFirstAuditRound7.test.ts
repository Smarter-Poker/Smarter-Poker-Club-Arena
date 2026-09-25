/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ROUND 7 OF THE SPIN AUDIT — NINE WAYS A SEAT-FIRST GAME COULD STILL LIE
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Every pin below is a defect that was in `main` on 2026-08-28, found by reading
 * the seat-first path end to end rather than by a report. They share one shape:
 * the code answered a question it had not actually been able to answer, and
 * presented the guess with the same confidence as a fact. A failed read became
 * "you are in nothing"; an empty election became "here is the table"; a null
 * balance became "0"; a slug compared against a UUID became "not your club".
 *
 * The first is the one that could have moved money, and it was mine: the
 * recycled-tile sibling hop I added in #1642 matched a replacement game on
 * name + buy-in + variant with NO CLUB SCOPE. Spin names on this platform are
 * identical by construction, so the only thing standing between a player and
 * another club's game was that exactly one club runs spins today (verified:
 * 33 registering spins, 33 distinct name+price keys, 1 club). That is a
 * coincidence, not a guard.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { sliceMethod, sliceStatement, sliceEnclosingBlock } from '../helpers/sourceWindow';

const readSrc = (p: string) => readFileSync(resolve(__dirname, '../../src', p), 'utf8');

const club = readSrc('pages/ClubHomePage.tsx');
const table = readSrc('pages/TablePage.tsx');
const panel = readSrc('components/lobby/GameLobbyPanel.tsx');
const service = readSrc('services/TableService.ts');

describe('a recycled tile can only hop to a sibling in the SAME club', () => {
  it('the replacement query is scoped by the origin game own club and price', () => {
    // The whole hop, bounded by the block it lives in — never a byte count.
    const hop = sliceEnclosingBlock(club, "eq('status', 'REGISTERING')");
    expect(hop).toContain("eq('club_id', originClubId)");
    // Name alone is not identity when every spin at a price shares one name.
    expect(hop).toContain("eq('name', t.name)");
    expect(hop).toContain("eq('buy_in_amount'");
    // And it must refuse to guess when the origin club could not be read.
    expect(hop).toContain('originClubId');
  });

  it('an unreadable origin row yields no sibling rather than an unscoped one', () => {
    expect(club).toContain('const originClubId =');
    // The ternary short-circuits to a null result when there is no club id;
    // there must be no path that runs the query without the scope.
    const hop = sliceEnclosingBlock(club, "eq('status', 'REGISTERING')");
    expect(hop.match(/eq\('club_id', originClubId\)/g) || []).toHaveLength(1);
  });
});

describe('membership is only revoked on proof of non-membership', () => {
  it('both reads report the error instead of treating it as "not a member"', () => {
    // A failed read used to fall through to navigate('/invite/...'), throwing a
    // paying member out of the club they were already inside.
    // Two reads, two report sites: the fast path and the full load.
    const errs = club.match(/'ClubHomePage\.[A-Za-z.]*membership_unreadable'/g) || [];
    expect(errs).toHaveLength(2);
    expect(club).toContain('if (memErr)');
    expect(club).toContain('if (memberResult.error)');
  });
});

describe('the post-spin result card never invents a losing result', () => {
  it('any of the three reads failing throws to the honest all-nulls path', () => {
    const fn = sliceEnclosingBlock(table, 'const [entryRes, tourneyRes, countRes]');
    expect(fn).toContain('if (entryRes.error) throw entryRes.error;');
    expect(fn).toContain('if (tourneyRes.error) throw tourneyRes.error;');
    expect(fn).toContain('if (countRes.error) throw countRes.error;');
  });
});

describe('seat-first recovery restores the FORMAT, not only the price', () => {
  it('it sets tournamentFormat from the persisted fixed format', () => {
    expect(table).toContain('const formatKind = getTournamentFormatKind(row)');
    expect(table).toContain('isSeatFirstTournamentFormat(row) && maxP !== null');
    expect(table).toContain("setTournamentFormat(isSpin ? 'spin' : 'sng');");
  });
});

describe('the buy-in panel and the board row give the SAME answer', () => {
  it('both seat-first branches defer to seatFirstJoinable', () => {
    expect(panel).toContain('import { parseTableSettings, seatsTakenLabel, seatFirstJoinable }');
    // Once for the spin branch, once for the heads-up branch.
    expect(panel.match(/if \(!seatFirstJoinable\(entry\)\)/g) || []).toHaveLength(2);
  });

  it('a game that cannot be joined offers Watch, never a buy-in CTA', () => {
    const spin = sliceEnclosingBlock(panel, "run: () => onSpinJoin(t, 'spin') };", 1);
    expect(spin).toContain("label: 'Watch'");
  });
});

describe('the lobby fetch and the realtime filter cannot drift apart', () => {
  it('one array feeds both, so a status can never half-land', () => {
    expect(club).toContain('const LOBBY_TOURNAMENT_STATUSES = [');
    expect(club).toContain("in('status', LOBBY_TOURNAMENT_STATUSES)");
    expect(club).toContain('LOBBY_TOURNAMENT_STATUSES.includes(String(row.status))');
    // The hand-typed shorter copy is gone.
    expect(club).not.toContain('JOINABLE_TOURNAMENT_STATUS');
  });

  it('the array still carries the two statuses the realtime filter was missing', () => {
    const decl = sliceStatement(club, 'const LOBBY_TOURNAMENT_STATUSES = [');
    for (const s of ['REGISTERING', 'RUNNING', 'LATE_REG', 'STARTING_SOON'])
      expect(decl).toContain(`'${s}'`);
  });
});

describe('an election that finds nothing is reported, not silently replaced', () => {
  it('resolveTournamentLiveTable reports the succeeded-but-empty case', () => {
    const fn = sliceMethod(
      service,
      'async resolveTournamentLiveTable(tournamentId: string): Promise<string | null> {'
    );
    expect(fn).toContain('TableService.resolveTournamentLiveTable_rpc_empty');
    // Still falls through — a degraded answer beats a dead end for the player.
    expect(fn).toContain("neq('status', 'closed')");
  });
});

describe('a bought seat reads SEATED in the lobby', () => {
  it('the seat set carries the tournament id alongside the table id', () => {
    // A spin row is keyed by tournament id, so a set of table ids alone could
    // never satisfy playerStateOf's first branch.
    expect(club).toContain("select('table_id, tables!table_seats_table_id_fkey(tournament_id)')");
    expect(club).toContain('tournamentId ? [r.table_id, tournamentId] : [r.table_id]');
  });
});

describe('the owner Delete control compares like with like', () => {
  it('club membership of a row is judged by the resolved UUID, not the slug', () => {
    const block = sliceEnclosingBlock(club, 'selectedEntry.players === 0 &&');
    expect(block).toContain('=== resolvedClubId');
    expect(block).not.toMatch(/club_id\s*===\s*clubId\b/);
  });
});

describe('an unknown wallet balance is not printed as zero', () => {
  it('the buy-in sheet says Unknown while the balance is unreadable', () => {
    /* The word, not a dash: check-ui-text forbids em dashes in UI copy
       (Dan 2026-08-20) and a hyphen beside a number reads as a minus sign
       on a wallet figure, which is worse than the 0 this replaced. */
    expect(table).toContain(
      "{accountBalance === null ? 'Unknown' : Number(accountBalance).toLocaleString()}"
    );
    expect(table).not.toContain('Your Balance {Number(accountBalance || 0).toLocaleString()}');
  });
});

describe('a failed floor read cannot silently drop the rejoin minimum', () => {
  it('the error is captured and reported', () => {
    /* CHIP CONTINUITY (2026-09-04): the per-table table_cashout_history read
       became the server-side fn_cash_effective_buyin call (keyed on club +
       variant + blinds). The property pinned here is unchanged: a failed read
       is reported, never mistaken for "no minimum". */
    expect(table).toContain(
      'const { data: effectiveBuyIn, error: floorErr } = await supabase.rpc('
    );
    expect(table).toContain("reportError(floorErr, 'TablePage.effective_buyin_read')");
  });
});

describe('the seat-bought toast counts from live values, not a stale closure', () => {
  it('it reads refs rather than state its dependency list does not carry', () => {
    expect(table).toContain('const seatFirstSeatsRef = useRef<number>(0);');
    expect(table).toContain('seatFirstSeatsRef.current = seatFirstBuyIn?.seats ?? 0;');
    expect(table).toContain('res.seats_needed ?? seatFirstSeatsRef.current');
    expect(table).toContain(
      'res.seats_taken ?? tableStateRef.current.players.filter(Boolean).length'
    );
  });
});
