/**
 * A CONTROL THAT SAYS "NONE" MUST ACTUALLY MEAN NONE.
 *
 * 2026-08-31. TableConfigPage's "Run It Multi-Times" radio offered None /
 * Player's Choice / Mandatory Twice / Mandatory 3 Times, and buildTableData
 * wrote exactly one column from it:
 *
 *     run_it_twice_enabled: config.runItMode !== 'none',
 *
 * The engine's gate is not that column alone
 * (ServerTableEngineBase, configureRunItTwice):
 *
 *     ((run_it_twice ?? true) && (allow_run_it_twice ?? true))
 *       || (run_it_twice_enabled ?? false)
 *
 * `run_it_twice` and `allow_run_it_twice` both carry a DEFAULT of true, and
 * this page never wrote either, so the first term was satisfied on every row
 * it had ever created. Selecting None wrote `false` into the one column the
 * OR did not need. Measured on production the day it was found: 924 live cash
 * tables, 921 of them running run-it-twice with the host's setting reading
 * 'none'.
 *
 * That is money: run-it-twice splits the pot across boards. A host who
 * declined it still had their players' pots run twice.
 *
 * fn_tables_sync_rit is not a backstop - it mirrors the two columns only when
 * one of them is NULL, and this page writes a non-null false.
 *
 * Asserted at the source, because the regression is a property of the code
 * rather than of one render: somebody writes one of the three columns and
 * forgets the others. Every window below is bounded by the structure it is
 * about (see tests/helpers/sourceWindow) so it can never be outrun by the
 * body it watches.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { sliceEnclosingBlock, sliceMethod } from './helpers/sourceWindow';

const PAGE = readFileSync(resolve(__dirname, '..', 'src/pages/TableConfigPage.tsx'), 'utf8');

/** The object literal buildTableData returns, bounded by its own braces. */
const tableData = () => sliceEnclosingBlock(PAGE, 'run_it_twice_enabled:');

/**
 * One <Slider ... /> element, bounded by its own tag.
 *
 * NOT sliceEnclosingBlock: a JSX element is not brace-delimited, so walking
 * back to the nearest open `{` returns the whole surrounding render block and
 * happily matches a `min=` belonging to a DIFFERENT slider. The element's own
 * `<Slider` ... `/>` is the structure here, so that is what is sliced - and
 * the end is found by scanning, never by a byte count.
 */
const slider = (label: string, occurrence = 0): string => {
  let at = -1;
  for (let i = 0; i <= occurrence; i++) {
    at = PAGE.indexOf(`label="${label}"`, at + 1);
    if (at < 0) throw new Error(`slider("${label}") occurrence ${occurrence} not found`);
  }
  const open = PAGE.lastIndexOf('<Slider', at);
  const close = PAGE.indexOf('/>', at);
  if (open < 0 || close < 0) throw new Error(`slider("${label}") is not a <Slider .../> element`);
  return PAGE.slice(open, close + 2);
};

describe('run it twice is written on every column the engine reads', () => {
  it('writes all three booleans, not just run_it_twice_enabled', () => {
    const body = tableData();
    for (const col of ['run_it_twice:', 'allow_run_it_twice:', 'run_it_twice_enabled:']) {
      expect(body, `${col} must be written from the radio`).toContain(col);
    }
  });

  it('drives all three from the same control, so None switches the feature off', () => {
    const body = tableData();
    for (const col of ['run_it_twice', 'allow_run_it_twice', 'run_it_twice_enabled']) {
      const wired = new RegExp(`\\b${col}:\\s*config\\.runItMode !== 'none'`).test(body);
      expect(wired, `${col} must be derived from config.runItMode`).toBe(true);
    }
  });

  it('defaults to player_choice, so the fix does not switch RIT off platform-wide', () => {
    // 'none' and 'player_choice' are identical to the engine
    // (RunItTwiceEngine.mandatoryRuns returns 0 for both), and every table
    // this page created has in fact been offering the question. Defaulting to
    // 'none' once the columns are honest would silently remove the feature
    // from every newly created table.
    // The DEFAULT_CONFIG literal, not the interface field of the same name.
    expect(sliceMethod(PAGE, 'const DEFAULT_CONFIG')).toMatch(/runItMode:\s*'player_choice'/);
  });
});

describe('a slider may not offer a value the database refuses', () => {
  it('Action Time stays inside fn_tables_creation_guard 10..120', () => {
    // The guard raises 'action_time_seconds must be between 10 and 120'.
    // Both the cash slider and the SNG/MTT one write actionTimeSeconds.
    const count = PAGE.split('label="Action Time"').length - 1;
    expect(count, 'the Action Time sliders have gone').toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      const el = slider('Action Time', i);
      const min = el.match(/min=\{(\d+)\}/);
      const max = el.match(/max=\{(\d+)\}/);
      expect(min, 'Action Time needs an explicit min').not.toBeNull();
      expect(max, 'Action Time needs an explicit max').not.toBeNull();
      expect(Number(min![1]), 'below the engine floor and the DB guard').toBeGreaterThanOrEqual(10);
      expect(Number(max![1]), 'above what the DB guard accepts').toBeLessThanOrEqual(120);
    }
  });

  it('AutoStart cannot exceed the seat count, or the table never deals', () => {
    // A fixed numeric max is exactly the bug: Table Size caps at seatCap, so
    // a 6-seat PLO6 table could be told to wait for 10 players and would then
    // sit forever without even being reported as stuck.
    expect(slider('AutoStart')).toMatch(/max=\{Math\.min\(/);
  });

  it('Bomb Pot Min Players cannot exceed the seat count', () => {
    expect(slider('Bomb Pot Min Players')).toMatch(/max=\{Math\.min\(/);
  });
});

describe('a failed create tells the host why', () => {
  it('surfaces the server message rather than a fixed string', () => {
    // fn_tables_creation_guard raises host-actionable text and an RLS refusal
    // returns a permission error; both used to render as five fixed words.
    // `= async` disambiguates from handleSaveAsTemplate / handleStartTournament.
    for (const handler of ['const handleSave = async', 'const handleStart = async']) {
      const body = sliceMethod(PAGE, handler);
      expect(body, `${handler} must surface error.message`).toMatch(
        /error instanceof Error && error\.message/
      );
    }
  });
});
