/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE NEAR-MISS LOG HAS A READER
 *  BBJ programme, post-audit phase 3 of 5 (2026-09-11)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `bbj_near_misses` was built on 2026-09-07 to answer one question: the main
 * jackpot had paid nothing in seventeen days on the highest volume in the
 * platform's history, and nothing in the database could say whether that was
 * the rules working or the rules broken - "no qualifying hand occurred" and
 * "a qualifying hand occurred and something refused it" were the same
 * observation. Its own table comment cites CLAUDE.md 10.86 for this.
 *
 * 10.86 rule 3 is "A GUARD MUST HAVE A READER, AND YOU MUST NAME THEM." Four
 * days later the table had three writers and, across both repos, NOT ONE
 * SELECT. Fifty-seven rows nobody could see. A log that cites the reader rule
 * and then has no reader is worse than no log, because the question reads as
 * answered.
 *
 * This law is what keeps the reader attached, and keeps it honest about three
 * specific ways it could quietly stop answering:
 *
 *   1. THE READER EXISTS AND IS CALLED. A function in the database plus a
 *      surface that calls it. Either half alone is the defect again.
 *   2. EVERY GATE THE ENGINE CAN NAME HAS A LABEL. The labels are keyed on the
 *      reason strings in `server/src/config/RakeConfig.ts`. Add a gate there
 *      without a label here and an operator reads raw snake_case.
 *   3. "COULD NOT READ" IS NOT "NOTHING WAS REFUSED". Two opposite findings
 *      that both render as an empty list, and the emptier one looks like good
 *      news. 10.86 rule 1.
 *
 * A NOTE ON WHERE THE VOCABULARY COMES FROM. The log's creating migration
 * (20260907201404) lists five reasons in a block comment - `pot_below_floor`,
 * `not_enough_dealt`, `no_ace_in_hand`, `both_cards_did_not_play`,
 * `winner_not_strong_enough` - and NO WRITER EMITS ANY OF THEM. All 57 live
 * rows carry one of four different names. This law reads the engine, never
 * that comment, and pins the fiction so nobody re-derives a label set from it.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

const PANEL = 'src/components/bbj/BBJAdminAnalytics.tsx';
const ENGINE_RULES = 'server/src/config/RakeConfig.ts';
const WRITER = 'server/src/services/supabase/bbj.ts';

/** The reason strings the engine can write, read from the engine itself. */
function enginesReasons(): string[] {
  const src = read(ENGINE_RULES);
  const out = new Set<string>();
  for (const m of src.matchAll(/reason:\s*'([a-z0-9_]+)'/g)) {
    const r = m[1];
    /* The near-miss detectors are the only place in this file that names a
       gate; both the main and the mini set live inside them. */
    if (
      r.startsWith('mini_') ||
      ['not_enough_players', 'pot_too_small', 'winner_not_quads', 'both_cards_must_play'].includes(
        r
      )
    ) {
      out.add(r);
    }
  }
  return [...out].sort();
}

describe('the near-miss log has a reader', () => {
  it('the engine still names the gates this law was written against', () => {
    /* If this list shrinks, a gate was deleted and its label is now dead
       weight; if it grows, the next assertion catches the missing label. It is
       spelled out so the diff says which gate changed. */
    expect(enginesReasons()).toEqual([
      'both_cards_must_play',
      'mini_double_board',
      'mini_loser_below_bar',
      'mini_not_enough_players',
      'mini_pot_too_small',
      'mini_winner_not_quads',
      'not_enough_players',
      'pot_too_small',
      'winner_not_quads',
    ]);
  });

  it('every gate the engine can name has a label on the panel', () => {
    const panel = read(PANEL);
    const missing = enginesReasons().filter(
      (r) => !new RegExp(`\\b${r}:\\s*'`).test(panel) && !panel.includes(`${r}:`)
    );
    expect(missing).toEqual([]);
  });

  it('a reason with no label still reaches the operator, never a blank row', () => {
    const panel = read(PANEL);
    // `NEAR_MISS_LABELS[reason] ?? reason` - the raw string is the fallback.
    expect(panel).toMatch(/NEAR_MISS_LABELS\[\s*reason\s*\]\s*\?\?\s*reason/);
  });

  it('mini_refused is classified before mini_, and never reads as a near miss', () => {
    const panel = read(PANEL);
    const refusedAt = panel.indexOf("startsWith('mini_refused:')");
    expect(refusedAt).toBeGreaterThan(-1);
    // It says a player MADE the hand; it is not counted as a failure to qualify.
    expect(panel).toMatch(/Mini Qualified But Was Turned Away/);

    /* The database classifier has to order the two the same way, or a mini the
       payout turned away is filed as a hand that never qualified. */
    const migration = latestReaderMigration();
    const dbRefused = migration.indexOf("'mini\\_refused:%'");
    const dbMini = migration.indexOf("'mini\\_%'");
    expect(dbRefused).toBeGreaterThan(-1);
    expect(dbMini).toBeGreaterThan(-1);
    expect(dbRefused).toBeLessThan(dbMini);
  });

  it('the panel calls the reader, so the log is not write-only again', () => {
    expect(read(PANEL)).toContain('fn_bbj_near_miss_summary');
  });

  it('the reader exists in a migration, scoped and authorised at its own surface', () => {
    const migration = latestReaderMigration();
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.fn_bbj_near_miss_summary');
    // Takes a pool, so it can be scoped out of. Never a roster with no argument.
    expect(migration).toMatch(/fn_bbj_near_miss_summary\(\s*\n?\s*p_pool_id uuid/);
    // Reads who is asking HERE, not one call down where the guard cannot see it.
    expect(migration).toMatch(/IF auth\.uid\(\) IS NULL THEN/);
    expect(migration).toContain('fn_is_club_admin_uid');
    expect(migration).toContain('fn_is_platform_admin');
    // And the table itself stays shut: the reader is the only way in.
    expect(migration).toMatch(/has_table_privilege\('anon', 'public\.bbj_near_misses', 'SELECT'\)/);
  });

  it('"could not read" is a distinct outcome from "nothing was refused"', () => {
    const panel = read(PANEL);
    expect(panel).toContain("'unavailable'");
    // Three states, not a boolean.
    expect(panel).toMatch(/type NearMissState\s*=\s*'loading'\s*\|\s*'ok'\s*\|\s*'unavailable'/);
    // The unreadable case says so in words rather than rendering an empty list.
    expect(panel).toMatch(/Could Not Be Read, So This Is Not An Answer Either Way/);
  });

  it('the writer still cannot gate a payout, and still refuses to write a null reason', () => {
    const writer = read(WRITER);
    // Fire-and-forget: the failure path reports, it never throws upward.
    expect(writer).toMatch(/reportError\(error, 'bbj\.near_miss_not_recorded'/);
    expect(writer).not.toMatch(/throw .*near_miss/i);
    // A near miss with no reason is a detector answering without knowing.
    expect(writer).toMatch(/reason:\s*params\.reason\s*\?\?\s*'unspecified'/);
  });

  it('the fiction in the creating migration is not a source of labels', () => {
    const panel = read(PANEL);
    /* These five are named by 20260907201404's prose and by no writer. If one
       appears as a label key, somebody has built the reader from the comment
       instead of from the engine. */
    for (const ghost of [
      'pot_below_floor',
      'not_enough_dealt',
      'no_ace_in_hand',
      'both_cards_did_not_play',
      'winner_not_strong_enough',
    ]) {
      expect(panel).not.toContain(`${ghost}:`);
    }
  });
});

/** The migration that declares the reader, found by content not by filename. */
function latestReaderMigration(): string {
  const dir = resolve(ROOT, 'supabase/migrations');
  const hit = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .reverse()
    .map((f) => readFileSync(resolve(dir, f), 'utf8'))
    .find((s) => s.includes('CREATE OR REPLACE FUNCTION public.fn_bbj_near_miss_summary'));
  if (!hit) throw new Error('no migration declares fn_bbj_near_miss_summary');
  return hit;
}
