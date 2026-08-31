/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE 2026-08-23 LEDGER — EACH LINE HERE COST A PRODUCTION OUTAGE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Why this file exists rather than trusting the individual test files.
 *
 * The morning's outage was not caused by somebody writing a bug. It was caused
 * by PR #542 landing on top of a fix, reverting `.not('status','in',...)` to a
 * JS array — and EDITING THE TEST that was catching it, with the commit
 * message "test: fix regex to match actual source code". Every gate was green
 * while every club lobby showed zero cash tables.
 *
 * At the time of writing there are fifteen open pull requests, eight of them
 * touching files repaired today, four already conflicting with main. Each will
 * be rebased or hand-resolved by somebody who was not here for any of this.
 *
 * So this is one file, in one place, that says out loud what each line is FOR.
 * A conflict resolution that drops one of them fails here with the reason
 * attached, not with a regex mismatch in a file about something else.
 *
 * If you are here because this test failed: you have re-introduced a specific,
 * known, measured production incident. The message tells you which one.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(__dirname, '../../');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

/**
 * Comments in this repo QUOTE the code they replaced — that is the house style
 * and it is a good one. It also means a "must not contain" assertion matches
 * the explanation of the bug and reports the bug as present. Strip comments
 * before asserting absence; assert presence against the raw text, where a
 * comment cannot fake a real implementation.
 */
const codeOnly = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n');

const clubHome = read('src/pages/ClubHomePage.tsx');
const filterSpec = read('src/components/lobby/advancedFilterSpec.ts');
const recurring = read('server/src/services/TournamentRecurringService.ts');
const leadership = read('server/src/services/leadership.ts');
const deployWf = read('.github/workflows/auto-deploy-hetzner.yml');

describe('the lobby showed zero cash tables in every club', () => {
  it('does not pass a JS array where PostgREST wants a group', () => {
    // `.not(col,'in',['closed','deleted'])` serialises to `not.in.closed,deleted`
    // and returns 400 PGRST100. The whole table list comes back null.
    expect(clubHome).toMatch(/\.not\('status', 'in', '\("closed","deleted"\)'\)/);
    expect(codeOnly(clubHome)).not.toMatch(/\.not\(\s*'[a-z_]+'\s*,\s*'in'\s*,\s*\[/);
  });

  it('says something when the table query fails instead of rendering an empty club', () => {
    expect(clubHome).toMatch(/ClubHomePage\.tablesQueryFailed/);
  });
});

describe('a degraded read must not erase a good lobby', () => {
  it('never replaces a painted tournament list with an empty one', () => {
    // get_club_home returned 161 tournaments and the lobby showed none, with
    // "44 Games Are Open In This Club" underneath - 44 being the tables alone.
    // The chain had narrowed to the club's own private tournaments because
    // unionId did not resolve, and then overwrote the good list with zero.
    expect(clubHome).toMatch(/ClubHomePage\.emptyTournamentOverwrite/);
    expect(clubHome).toMatch(/if \(allTournaments\.length > 0\)/);
  });

  it('treats a clean "no union row" as inconclusive, not as standalone', () => {
    // A 200 with zero rows is not an error, so no branch treated it as one -
    // and this one ignored the cached answer the browser already held.
    expect(clubHome).toMatch(/union_id \|\| readCachedUnion\(\)/);
  });
});

describe('the club header counted the wrong things and flipped between them', () => {
  it('counts THIS club members, never the union total', () => {
    // JAQK (584) and Shark (588) both read 1,172, and the header flipped
    // between the two answers depending on which query landed last.
    expect(codeOnly(clubHome)).not.toMatch(/totalMembers/);
  });

  it('reads players-currently-playing from live seats, not the stale column', () => {
    expect(clubHome).toContain('playersPlaying={playersPlaying}');
    expect(codeOnly(clubHome)).not.toMatch(/club\.online_count\.toLocaleString/);
  });
});

describe('an untouched filter deleted every MTT in the club', () => {
  it('treats a seat range at its default as no filter at all', () => {
    // isFilterActive called it inactive while rowPassesFilter enforced it, so
    // the empty state offered no filter to clear and was wrong on both counts.
    expect(filterSpec).toMatch(/const atDefault =/);
  });

  it('measures Table Size against the table, not the size of the field', () => {
    // FILTER_SPECS.MTT.seats is {2,9}; max_players is 150-1000.
    expect(filterSpec).toMatch(/'tableSeats' in r/);
  });
});

describe('44 of 50 Spins and Heads-Ups could never be joined', () => {
  it('repairs table-less seat-first games BEFORE deciding what is missing', () => {
    const spinTick = recurring.indexOf("withBoardTick('spin'");
    const repair = recurring.indexOf('this.repairSeatFirstGames()', spinTick);
    const budget = recurring.indexOf('const budget = { left: BURST }', spinTick);
    expect(repair).toBeGreaterThan(spinTick);
    expect(repair).toBeLessThan(budget);
  });

  it('will not count a game without a joinable table as covering its price point', () => {
    // One dead REGISTERING row — table-less or backed by a closed table —
    // wedged one price point permanently.
    expect(recurring).toMatch(/withJoinableTable\.has\(r\.id\)/);
    expect(recurring).toContain('isJoinableTableRow');
  });

  it('keeps a floor of horses for the cash room', () => {
    // The board drank the fleet the hour it started working: 44 cash tables
    // holding 72 seats between them while 425 horses sat in tournaments.
    expect(recurring).toMatch(/CASH_FLOOR_PER_TABLE/);
    expect(recurring).toMatch(/cashRoomReserve/);
  });
});

describe('two engines both believed they were the leader', () => {
  it('starts a fresh process as a standby', () => {
    // Boot default 'leader' meant a new container answered /health with 200
    // and took traffic before it had been granted anything. Live result: two
    // leaders, fleet split 14 tables to 10.
    expect(leadership).toMatch(/let role: EngineRole = 'standby';/);
  });

  it('does not treat an empty answer as a grant', () => {
    expect(codeOnly(leadership)).not.toMatch(/if \(!row \|\| row\.granted\)/);
  });

  it('still promotes a lone instance rather than leave the fleet unowned', () => {
    expect(leadership).toMatch(/PROMOTE_AFTER_UNKNOWN/);
  });
});

describe('the engine ran eight-hour-old code behind a green pipeline', () => {
  it('verifies against the container, not the load-balanced hostname', () => {
    // Caddy failed over to an unmanaged twin while 8080 restarted, so the
    // deploy read the OTHER instance's version and rolled back a good build.
    expect(deployWf).toMatch(/127\.0\.0\.1:\$\{PORT:-8080\}\/health/);
  });

  it('then requires the public hostname to serve that same SHA', () => {
    expect(deployWf).toMatch(/does not — another instance is answering that hostname/);
  });

  it('refuses to deploy while an unmanaged engine is running', () => {
    expect(deployWf).toMatch(/Unmanaged engine container\(s\) running alongside/);
  });
});

describe('every hand on the platform queued behind one database row', () => {
  it('ships the migration that takes the shared row last', () => {
    const p = 'supabase/migrations/20260823340000_hand_history_stops_serialising_on_one_row.sql';
    expect(existsSync(join(ROOT, p))).toBe(true);
    const sql = read(p);
    // The assertion inside the migration is what enforces the ordering in the
    // database; this only proves the migration is still shipped.
    expect(sql).toMatch(/club_hand_daily is not the last write/);
    expect(sql.indexOf('INSERT INTO club_hand_daily')).toBeGreaterThan(
      sql.indexOf('INSERT INTO club_member_daily_stats')
    );
  });
});
