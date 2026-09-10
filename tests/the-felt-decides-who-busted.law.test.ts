/**
 * THE FELT DECIDES WHO BUSTED (2026-09-10).
 *
 * tournament_players.chips MIRRORS the seat. The seat is where the engine
 * settles every hand; the mirror is a projection. Two readers trusted the
 * mirror, and between them they minted chips, stalled tournaments and refused
 * hands:
 *
 *   - fn_ca_assign_tournament_player_seat_locked took a moved player's new
 *     stack from the mirror. Night Owl Special b84f312f, from the engine's own
 *     hand records: 256,000 + 128,000 = 384,000 at 18:01, exactly the
 *     48 x 8,000 bought in; a move at 22:34:25 wrote 448,000 over a felt of
 *     256,000. +192,000 minted, -128,000 destroyed, net +64,000.
 *
 *   - fn_ca_eliminate_absent_tournament_players filtered on
 *     COALESCE(p.chips,0) <= 0, so it skipped exactly the rows whose mirror was
 *     wrong: 39 of 68 seatless players carried chips > 0 there (151,500 chips)
 *     while the highest stack they ever held on any seat was ZERO. It also
 *     tested EVERY seat row for stack > 0, and a vacated seat keeps its stack,
 *     so anyone who had ever held chips could never be eliminated.
 *
 * These pin the property, not the phrasing: neither reader may go back to the
 * mirror, and a seat assignment may never raise a tournament's live chip total
 * above what was bought in.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const MIGRATIONS = path.join(process.cwd(), 'supabase/migrations');

function migrationNamed(slug: string): string {
  const hit = fs
    .readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(`_${slug}.sql`))
    .sort();
  expect(
    hit.length,
    `exactly one migration should carry the slug ${slug}; found ${hit.length}`
  ).toBe(1);
  return fs.readFileSync(path.join(MIGRATIONS, hit[0]), 'utf8');
}

const SQL = migrationNamed('the_felt_decides_who_busted');

describe('the move reads the felt, not the mirror', () => {
  it('reads the stack from the seat the player is leaving', () => {
    expect(SQL).toContain('SELECT ts.stack INTO v_felt_stack');
    expect(SQL).toContain('AND ts.left_at IS NULL');
  });

  it('falls back to the mirror ONLY when there is no live seat', () => {
    expect(SQL).toContain('v_stack:=COALESCE(v_felt_stack,COALESCE(v_tp.chips,0));');
  });

  it('no longer takes a moved stack straight from the mirror', () => {
    // The exact line that minted 192,000 chips. It must not come back.
    expect(SQL).not.toContain('  ELSE\n    v_stack:=COALESCE(v_tp.chips,0);\n  END IF;');
  });
});

describe('a seat assignment can never mint tournament chips', () => {
  it('carries the conservation gate', () => {
    expect(SQL).toContain('tournament_chip_conservation');
    expect(SQL).toContain('bought_in_cap');
  });

  it('subtracts the player OWN live seat before adding the new stack, so a normal move is a no-op', () => {
    expect(SQL).toContain('(v_live_total-v_own_live+v_stack)>v_live_total');
  });

  it('tolerates an existing overage and refuses only growth', () => {
    // Both halves are required: > current total AND > the bought-in cap.
    expect(SQL).toContain('AND (v_live_total-v_own_live+v_stack)>v_cap_chips');
  });

  it('derives the cap from what was actually bought in', () => {
    expect(SQL).toContain('count(*)*COALESCE(v_t.starting_chips,0)');
    expect(SQL).toContain('COALESCE(sum(tp2.rebuys),0)*COALESCE(v_t.rebuy_chips,0)');
    expect(SQL).toContain('tp2.add_on');
  });
});

describe('the eliminator reads the felt too', () => {
  it('refuses to finish while the live function still filters on the mirror', () => {
    // The migration necessarily QUOTES the old predicate - it is the search
    // anchor. What matters is the post-condition: it re-reads the installed
    // function and aborts if that string survived the replace.
    expect(SQL).toContain("OR position('AND COALESCE(p.chips, 0) <= 0' in v_check) > 0 THEN");
    expect(SQL).toContain('the eliminator still reads the mirror');
  });

  it('replaces the mirror clause rather than adding beside it', () => {
    // The old predicate appears exactly once: as the anchor. If a second copy
    // appears, the replacement re-introduced it.
    const hits = SQL.split('AND COALESCE(p.chips, 0) <= 0').length - 1;
    // Exactly three, and each is accounted for: the header comment naming the
    // defect, the search anchor, and the post-condition that refuses if it
    // survived. A fourth would mean the replacement put it back.
    expect(
      hits,
      'the mirror predicate is quoted three times: comment, anchor, post-condition'
    ).toBe(3);
  });

  it('asks what the seat they LAST LEFT held, not whether any seat ever held chips', () => {
    expect(SQL).toContain('ORDER BY s.left_at DESC NULLS FIRST, s.joined_at DESC');
    expect(SQL).toContain('LIMIT 1), 0) <= 0');
  });

  it('still requires that the player holds no live seat', () => {
    expect(SQL).toContain('AND s.left_at IS NULL)');
  });
});

describe('the migration proves itself rather than asserting', () => {
  it('refuses to run if either anchor is not unique', () => {
    expect(SQL).toMatch(/expected exactly 1|appears % times/);
  });

  it('carries a post-condition that both readers changed', () => {
    expect(SQL).toContain('post-condition');
  });
});
