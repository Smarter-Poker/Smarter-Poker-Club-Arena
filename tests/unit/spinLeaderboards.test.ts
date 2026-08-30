/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  SPIN LEADERBOARDS ARE RANKED BY THE DATABASE, NOT THE BROWSER (round 15)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The Spin view already showed the seven-day Biggest Hits strip. It could not
 * answer the two questions a regular spin player actually asks - who plays the
 * most, and who is up - because answering either means aggregating every spin
 * in the window, and this platform runs ~1,800 spins a day. Paging that into
 * the browser to rank ten names would be the same mistake round 12 removed
 * from the results feed (`fetchAllRows` scan -> `tournament_players!inner`).
 *
 * So the aggregation lives in `fn_spin_leaderboards(p_days)`, applied to
 * production 2026-08-29: SECURITY DEFINER, search_path pinned, revoked from
 * anon, and - the part that matters - carrying NO `is_horse` filter.
 *
 * The pins below are the three things that can silently rot:
 *
 *   1. HORSES ARE PLAYERS (CLAUDE.md 10.5). A leaderboard is exactly the
 *      shape of code where somebody "tidies up" by hiding horses. The
 *      migration must never grow an is_horse exclusion, and neither may the
 *      client. This is the pin that made the law worth writing: on 2026-08-27
 *      an invented `AND NOT is_horse` in fn_settle_tournament_rake zeroed
 *      rake attribution across 39 settled events.
 *
 *   2. THE READ IS ERROR-BOUND. This file is held at ZERO discarded-error
 *      reads by discardedErrorReadRatchet.test.ts. A `const { data } =` here
 *      would render an empty podium on a failed RPC - and an empty podium
 *      does not read as "the request failed", it reads as "nobody has
 *      played", which is the single most discouraging thing a leaderboard
 *      can say to a player who spun forty times this week.
 *
 *   3. IT STAYS ON THE SPIN VIEW. The boards are spin-specific; leaving them
 *      mounted under the MTT or Sit & Go filter would show spin ranks beside
 *      non-spin results.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sliceEnclosingBlock } from '../helpers/sourceWindow';

const root = join(__dirname, '..', '..');
const PAGE = readFileSync(
  join(root, 'src', 'pages', 'tournament', 'TournamentResultsPage.tsx'),
  'utf8'
);
/**
 * TWO migrations, and the SECOND one is the live definition.
 *
 * The first cut collected its window into a temp table and read it three
 * times. `check-definer-authorization` blocked the push and it was right to:
 * what it saw was a SECURITY DEFINER function a browser role can execute,
 * running INSERT and DELETE, that never asks auth.uid() who is calling. The
 * guard cannot tell a temp table from a real one, and the shape it looks for
 * was genuinely there.
 *
 * The fix was not an allowlist entry. A leaderboard has no business writing
 * anything, so it is CTEs now, `language sql stable`, and Postgres itself
 * enforces the claim.
 */
const MIGRATION = readFileSync(
  join(root, 'supabase', 'migrations', '20260830053746_spin_leaderboards.sql'),
  'utf8'
);
const READ_ONLY = readFileSync(
  join(root, 'supabase', 'migrations', '20260830064500_spin_leaderboards_read_only.sql'),
  'utf8'
);

/** The page with every comment removed, so a pin can never be satisfied by
 *  prose ABOUT the code instead of the code (handoff trap #6 - a grep for a
 *  deleted string once returned 1 because it matched my own explanation). */
const CODE = PAGE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const RPC_ANCHOR = "supabase.rpc('fn_spin_leaderboards'";
/** The `try { ... }` that performs the read. */
const TRY_BLOCK = sliceEnclosingBlock(CODE, RPC_ANCHOR, 0, 1);
/** One level out: the async arrow body, so the `catch` is in view too. */
const EFFECT_BODY = sliceEnclosingBlock(CODE, RPC_ANCHOR, 0, 2);

describe('the aggregation happens server-side', () => {
  it('the page calls the RPC rather than paging spins into the browser', () => {
    expect(CODE).toContain("supabase.rpc('fn_spin_leaderboards'");
    expect(CODE).toContain('p_days: 7');
  });

  it('the RPC exists in a committed migration, not applied by hand', () => {
    expect(MIGRATION).toMatch(/create or replace function public\.fn_spin_leaderboards/i);
    expect(READ_ONLY).toMatch(/create or replace function public\.fn_spin_leaderboards/i);
    expect(READ_ONLY).toMatch(/security definer/i);
    expect(READ_ONLY).toMatch(/set search_path/i);
  });

  it('the RPC is not reachable by anon', () => {
    expect(READ_ONLY).toMatch(/revoke[\s\S]*?anon/i);
    expect(READ_ONLY).toMatch(/grant execute[\s\S]*?authenticated/i);
  });
});

describe('a leaderboard writes nothing', () => {
  it('the live definition is declared STABLE, so Postgres enforces it', () => {
    expect(READ_ONLY).toMatch(/language sql\s+stable/i);
  });

  it('it asserts its own volatility on apply, rather than trusting the DDL', () => {
    /* `stable` in the source is a claim; provolatile is the fact. The
       migration reads it back and refuses to land if it disagrees. */
    expect(READ_ONLY).toContain('provolatile');
    expect(READ_ONLY).toMatch(/must be STABLE/);
  });

  it('the temp table, and both statements that wrote to it, are gone', () => {
    const sql = READ_ONLY.replace(/--.*$/gm, '');
    expect(sql).not.toMatch(/create temp table/i);
    expect(sql).not.toMatch(/insert\s+into/i);
    expect(sql).not.toMatch(/delete\s+from/i);
  });

  it('and it still answers, checked on apply against real data', () => {
    expect(READ_ONLY).toMatch(/fn_spin_leaderboards\(7\)/);
    expect(READ_ONLY).toMatch(/did not return ok/);
  });
});

describe('HORSES ARE PLAYERS - they rank alongside humans', () => {
  it('the migration carries no is_horse exclusion anywhere', () => {
    for (const sql of [MIGRATION, READ_ONLY]) {
      expect(sql.replace(/--.*$/gm, '')).not.toMatch(/is_horse/i);
    }
  });

  it('the client does not filter horses out of the boards', () => {
    expect(EFFECT_BODY).not.toMatch(/is_horse/i);
  });
});

describe('the read cannot fail silently', () => {
  it('destructures the error and throws it', () => {
    expect(TRY_BLOCK).toMatch(
      /error:\s*\w+\s*\}\s*=\s*await supabase\.rpc\('fn_spin_leaderboards'/
    );
    expect(TRY_BLOCK).toMatch(/if \(\w*[Ee]rr\w*\) throw \w*[Ee]rr\w*;/);
  });

  it('a failure is reported and leaves the boards hidden, not empty', () => {
    expect(EFFECT_BODY).toContain('TournamentResultsPage.spin_leaderboards_load_failed');
    // The state starts null, and null is exactly what a failure leaves behind:
    // the block simply does not render. An empty array would render a podium
    // with no names on it, which reads as "nobody played", not "load failed".
    expect(EFFECT_BODY).not.toMatch(/catch[\s\S]*?setSpinBoards\(/);
    expect(CODE).toMatch(/useState<\{[\s\S]*?\} \| null>\(null\);\s*$/m);
  });

  it('does not set state after unmount', () => {
    expect(TRY_BLOCK).toContain('if (cancelled || !isMounted.current) return;');
  });
});

describe('the boards belong to the Spin view only', () => {
  it('clears itself when the filter leaves spin', () => {
    expect(CODE).toMatch(/if \(typeFilter !== 'spin'\) \{\s*setSpinBoards\(null\);/);
  });

  it('renders only under the spin filter', () => {
    expect(CODE).toContain("{typeFilter === 'spin' &&");
    expect(CODE).toContain('spinBoards &&');
  });

  it('renders nothing at all when both boards are empty', () => {
    expect(CODE).toMatch(/spinBoards\.mostSpins\.length > 0 \|\| spinBoards\.bestNet\.length > 0/);
  });
});

describe('the boards are usable on a phone', () => {
  it('the two tab controls meet the 32px touch minimum', () => {
    const button = sliceEnclosingBlock(CODE, 'setSpinBoardTab(tab)', 0, 2);
    expect(button).toMatch(/minHeight: 32/);
    expect(button).toContain("touchAction: 'manipulation'");
  });

  it('long usernames truncate rather than breaking the row', () => {
    expect(CODE).toContain("textOverflow: 'ellipsis'");
  });

  it('counts are thousands-separated, never padded', () => {
    // CLAUDE.md section 9: toLocaleString, never padStart.
    expect(CODE).toMatch(/spins\.toLocaleString\(\)/);
    expect(CODE).not.toMatch(/padStart\(/);
  });
});
