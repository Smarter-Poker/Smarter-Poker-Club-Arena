/**
 * ===========================================================================
 *  LAW: A HAND THAT ENDED PREFLOP HAS NO BOARD TO RECORD
 * ===========================================================================
 *
 * `fn_rake_law_violations` has a finding, `board_not_recorded`, that means
 * "this cash hand's community cards are missing from the record". It matters
 * more than a warning usually does: the finding returns NULL for the allowed
 * rake on purpose, and a hand with a NULL allowed rake is also excluded from
 * `over_spec` and `under_spec`. A hand it flags is a hand whose rake nobody
 * checked.
 *
 * Until 2026-09-21 it decided that with:
 *
 *     board_n = 0 AND (has_showdown OR agg >= 4)
 *
 * where `agg` counted every call, raise, bet and all-in in the hand. The
 * second disjunct is a PROXY for "a flop must have been dealt", and it is not
 * one. A limp, a raise, two calls and a three-bet is an ordinary multiway
 * preflop pot and clears four aggressive actions with no card on the table.
 *
 * Measured across ALL 61 hands the finding ever produced:
 *
 *     took rake ................................. 0
 *     took a BBJ drop ........................... 0
 *     reached a showdown ........................ 0
 *     had any action on a street after preflop .. 0
 *
 * A 100% false-positive rate for the whole life of the check. The damage was
 * not the noise: the board caps a source at 25 open incidents and diverts the
 * rest into one DETECTOR STORM row, this source reached the cap, and a genuine
 * over-rake filed by it would have landed in that row and read as more of the
 * same. A false positive that reaches the storm cap is a place for a real
 * finding to hide.
 *
 * Every action the engine writes already carries the street it happened on.
 * The check had the fact it needed in the record it was already reading and
 * consulted a head-count instead. That is the whole law: read the street off
 * the record, and when the record does not carry one, say so rather than
 * guessing either way.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const FIX =
  'supabase/migrations/20260921023500_a_hand_that_ended_preflop_has_no_board_to_record.sql';

/** This law lands here; anything newer is bound by the forward guard. */
const THIS_VERSION = '20260921023500';

const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SQL = read(FIX);
/** The migration with its prose taken out, for assertions about the DDL. */
const DDL = SQL.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

describe('a hand that ended preflop has no board to record', () => {
  it('the board test reads the street off the record', () => {
    expect(DDL).toMatch(
      /board_n = 0 AND \(has_showdown OR played_past_preflop OR streets_unreadable\)/
    );
    // played_past_preflop is derived from what the engine wrote, both on the
    // action and on its captured node - not from how many chips went in.
    expect(DDL).toMatch(/a->>'stage'[\s\S]{0,80}'flop','turn','river'/);
    expect(DDL).toMatch(/publicNode'->>'street'[\s\S]{0,80}'flop','turn','river'/);
  });

  it('the head-count proxy is gone, not merely unused', () => {
    // The DDL must not reinstate the counter in any form. The header names the
    // old test on purpose so the next reader meets it already argued against,
    // which is why this assertion is scoped to the DDL and not the prose.
    expect(DDL).not.toMatch(/agg\s*>=/);
    expect(DDL).not.toMatch(/'call','raise','bet','allin'/);
    expect(SQL, 'the header must still name the test it replaced').toContain(
      'board_n = 0 AND (has_showdown OR agg >= 4)'
    );
  });

  it('both genuine detections survive', () => {
    // A showdown on an empty board is impossible in every variant dealt here,
    // so it stays its own disjunct: 14 hands in a six-hour sample carried a
    // board with no post-flop action at all (preflop all-ins that ran out).
    expect(DDL).toContain('has_showdown');
    // And play that continued past preflop with no board recorded is still a
    // finding - that is the true positive this rule exists for.
    expect(DDL).toContain('played_past_preflop');
  });

  it('"I cannot tell" keeps its own outcome', () => {
    // Law 10.86 rule 1. A hand WITH actions, none of which names a stage, is
    // an unreadable record and must not be filed as "ended preflop".
    expect(DDL).toContain('streets_unreadable');
    expect(DDL).toMatch(/jsonb_array_length\(COALESCE\(hh\.actions[^)]*\)\) > 0/);
    expect(DDL).toMatch(/NOT EXISTS[\s\S]{0,200}NULLIF\(btrim\(COALESCE\(a->>'stage'/);
  });

  it('it proves both directions before it commits', () => {
    // Running the new rule is not proof on its own: a rule that flags nothing
    // would also run clean. So the migration proves the already-filed hands
    // stop flagging BECAUSE they ended preflop...
    expect(SQL).toMatch(/already-filed board_not_recorded hands would still flag/);
    // ...and that a flop is still detectable at all, or the "fix" is a delete.
    expect(SQL).toMatch(/would silence the finding rather than correct it/);
    // and it refuses to run against a definition it was not written for.
    expect(SQL).toContain('14112cd4618e295336bf78954e77fe53');
  });

  /**
   * THE ONE THAT MATTERS LATER. The next person to meet a noisy
   * board_not_recorded stream will be tempted by the two changes that make the
   * warnings stop without fixing anything: raise the threshold, or drop the
   * finding. Both are deletions wearing a fix's clothes.
   */
  it('no later migration reinstates an action count as the board test', () => {
    const offenders: string[] = [];
    for (const file of fs.readdirSync(MIGRATIONS).sort()) {
      if (!file.endsWith('.sql')) continue;
      if (file.slice(0, file.indexOf('_')) <= THIS_VERSION) continue;
      const sql = fs
        .readFileSync(path.join(MIGRATIONS, file), 'utf8')
        .replace(/--[^\n]*/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '');
      if (!/board_not_recorded/.test(sql)) continue;
      if (
        /agg\s*>=/.test(sql) ||
        /'call','raise','bet','allin'/.test(sql) ||
        !/board_n = 0 AND \(has_showdown OR played_past_preflop OR streets_unreadable\)/.test(sql)
      ) {
        offenders.push(file);
      }
    }
    expect(
      offenders,
      'a migration touches the board_not_recorded finding and either reinstates a ' +
        'count of aggressive actions as the test for a missing board, or drops one of ' +
        'the three disjuncts. The count is not a proxy for a flop - an ordinary ' +
        'multiway preflop pot clears four aggressive actions with no card on the ' +
        'table, and it gave this finding a 100% false-positive rate over all 61 hands ' +
        'it ever filed, enough to reach the storm cap and give a genuine over-rake ' +
        'somewhere to hide. Read the street off the record, keep the showdown ' +
        'disjunct, and keep streets_unreadable so an unreadable record is still ' +
        'reported. See 20260921023500.'
    ).toEqual([]);
  });
});
