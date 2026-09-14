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
  /* COMMENTS STRIPPED FIRST, and that is not tidiness. This scanned the raw
     file, so the comment explaining why `mini_loser_below_bar` had been
     DELETED - which quotes `reason: 'mini_loser_below_bar'` in order to
     explain it - was counted as a live gate. The law then demanded a label for
     a reason nothing could emit, the panel grew one, and both halves agreed
     about a gate that did not exist. It was green for the wrong reason from
     the day it was written, and I only found it by reading my own diff and
     noticing the expected list already held a value I had not added.

     Same lesson as the mini-surface law: a check that reads prose as code
     reports on prose. */
  const src = read(ENGINE_RULES)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
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
       payout turned away is filed as a hand that never qualified.

       SCOPED TO THE CASE EXPRESSION, not to the file. Comparing raw file
       offsets failed the moment a migration header explained the bug in prose
       above the code - the property was still true and the test said it was
       not. A law that reads whichever mention comes first in a file is a law
       about comment placement. */
    const caseBlock = /CASE\s*\n\s*WHEN s\.reason LIKE[\s\S]*?END AS kind/.exec(
      latestReaderMigration()
    )?.[0];
    expect(caseBlock, 'no WHEN/THEN classifier found in the reader migration').toBeTruthy();
    const dbRefused = caseBlock!.indexOf("'mini\\_refused:%'");
    const dbMini = caseBlock!.indexOf("'mini\\_%'");
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

  /* BOTH OF THESE ARE DEFECTS THE PHASE 3 DEEP DIVE FOUND IN PHASE 3'S OWN
     WORK, before it merged. They are pinned here because each one looked
     correct in review and was only visible by running it. */

  it('a null reason cannot reach the panel, and cannot crash it if it does', () => {
    /* `bbj_near_misses.reason` is nullable - the creating migration declared it
       `reason text` with no constraint. A null used to come back from the
       reader as a null (NULL LIKE 'mini\\_%' is NULL, so the CASE fell to
       'main'), and the panel called .startsWith() on it, which throws during
       render and blanks the entire Jackpot Health panel. Two belts: */
    const migration = latestReaderMigration();
    expect(migration).toMatch(/COALESCE\(s\.reason, 'unspecified'\)/);

    const panel = read(PANEL);
    expect(panel).toMatch(/if \(!reason\) return NEAR_MISS_LABELS\.unspecified;/);
    expect(panel).toMatch(/reason: string \| null \| undefined/);
  });

  it('every field the reader returns is rendered, none selected for nobody', () => {
    const panel = read(PANEL);
    /* `example` carries the sentence the engine already wrote for the player.
       It shipped selected by the SQL, justified at length in the migration
       header, declared on the interface - and rendered NOWHERE. Dead data that
       reads as wired is how a panel quietly stops telling the truth. */
    for (const field of ['refusals', 'reason', 'last_at', 'biggest_pot', 'example', 'kind']) {
      expect(
        new RegExp(`m\\.${field}`).test(panel),
        `the reader returns ${field} and the panel never renders it`
      ).toBe(true);
    }
  });

  it('the section heading is a label, not a claim about whether the pool paid', () => {
    /* FOUND BY LOOKING AT IT, 2026-09-12 - the first time any of this audit
       was seen on a screen. The heading read "Why It Has Not Paid" and sat
       four rows under the LAST HIT tile, which showed `0.3d` on BOTH live
       pools: the panel announced that the jackpot had not paid, directly
       below the number saying it had paid that morning.

       The rows were right; the heading asserted a premise nobody had checked
       against the tile above it. A heading on an operator panel has to be
       true whichever way the pool is running, because the list is worth
       reading when the jackpot is cold and when it is paying. */
    const panel = read(PANEL);
    const head = panel.slice(panel.indexOf('bbj-admin__misses-head'));
    const title = /bbj-admin__misses-title">([^<]+)</.exec(head)?.[1] ?? '';
    expect(title).toBeTruthy();
    expect(title).not.toMatch(/has not paid|hasn't paid|not paying|overdue/i);
  });

  it('every refusal the mini payout can return has a label', () => {
    /* A `mini_refused:<reason>` row is the one entry on this panel that is an
       incident - a hand that cleared the bar and was turned away. Rendering
       its reason as raw snake_case puts `no_mini_amount_for_tier` in front of
       an operator on the row that matters most. These five are the complete
       set fn_bbj_mini_payout can return, read from the live function on
       2026-09-12; a sixth added there without a label here fails this. */
    const panel = read(PANEL);
    for (const reason of [
      'reserve_at_floor',
      'mini_disabled_for_club',
      'mini_disabled_for_tier',
      'no_mini_amount_for_tier',
      'pool_not_found',
    ]) {
      expect(panel, `${reason} needs a label`).toMatch(new RegExp(`\\b${reason}:\\s*'`));
    }
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
