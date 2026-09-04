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
import { sliceMethod } from './helpers/sourceWindow';

const PAGE = readFileSync(resolve(__dirname, '..', 'src/pages/TableConfigPage.tsx'), 'utf8');
const FLOW = readFileSync(
  resolve(__dirname, '..', 'src/components/cash/CashGameCreateFlow.tsx'),
  'utf8'
);
/**
 * 2026-09-04 (Operation Table Stakes, Slice 1): the cash writer is
 * fn_cash_game_create in SQL. buildTableData is gone from the page, so the
 * object literal the pins below used to slice is now the VALUES list of the
 * one INSERT INTO public.tables that function makes.
 */
const SQL = readFileSync(
  resolve(__dirname, '..', 'supabase/migrations/20260904160500_cash_games_slice_1.sql'),
  'utf8'
);
const tablesInsert = () => {
  const at = SQL.indexOf('INSERT INTO public.tables (');
  const end = SQL.indexOf('RETURNING id INTO v_table_id', at);
  if (at < 0 || end < 0) throw new Error('fn_cash_game_create: tables INSERT not found');
  return SQL.slice(at, end);
};

/**
 * One <Slider ... /> element, bounded by its own tag.
 *
 * NOT sliceEnclosingBlock: a JSX element is not brace-delimited, so walking
 * back to the nearest open `{` returns the whole surrounding render block and
 * happily matches a `min=` belonging to a DIFFERENT slider. The element's own
 * `<Slider` ... `/>` is the structure here, so that is what is sliced - and
 * the end is found by scanning, never by a byte count.
 */
const slider = (source: string, label: string, occurrence = 0): string => {
  let at = -1;
  for (let i = 0; i <= occurrence; i++) {
    at = source.indexOf(`label="${label}"`, at + 1);
    if (at < 0) throw new Error(`slider("${label}") occurrence ${occurrence} not found`);
  }
  const open = source.lastIndexOf('<Slider', at);
  const close = source.indexOf('/>', at);
  if (open < 0 || close < 0) throw new Error(`slider("${label}") is not a <Slider .../> element`);
  return source.slice(open, close + 2);
};

describe('run it twice is written on every column the engine reads', () => {
  it('writes all three booleans, not just run_it_twice_enabled', () => {
    const body = tablesInsert();
    expect(body).toMatch(/run_it_mode, run_it_twice, allow_run_it_twice, run_it_twice_enabled,/);
  });

  it('drives all three from the same rule, so they can never disagree', () => {
    // OPORD 1.3 section 8: run it N times is opt-in per hand on every game.
    // 'player_choice' and all three booleans true are one line, written
    // together; there is no None to write, so None cannot half-apply.
    const body = tablesInsert();
    expect(body).toMatch(/^\s*'player_choice', true, true, true,\s*$/m);
  });

  it('defaults to player_choice, so the fix does not switch RIT off platform-wide', () => {
    // 'none' and 'player_choice' are identical to the engine
    // (RunItTwiceEngine.mandatoryRuns returns 0 for both). The flow offers
    // no radio at all and says so.
    expect(FLOW).toContain('Run It Multiple Times Is Opt In Per Hand');
    expect(FLOW).not.toContain('runItMode');
  });
});

describe('a slider may not offer a value the database refuses', () => {
  it('Action Time stays inside fn_tables_creation_guard 10..120', () => {
    // The guard raises 'action_time_seconds must be between 10 and 120'.
    // The cash flow's slider and the SNG/MTT one both write it.
    for (const [source, name] of [
      [PAGE, 'TableConfigPage'],
      [FLOW, 'CashGameCreateFlow'],
    ] as const) {
      const count = source.split('label="Action Time"').length - 1;
      expect(count, `${name}: the Action Time slider has gone`).toBeGreaterThan(0);
      for (let i = 0; i < count; i++) {
        const el = slider(source, 'Action Time', i);
        const min = el.match(/min=\{(\d+)\}/);
        const max = el.match(/max=\{(\d+)\}/);
        expect(min, 'Action Time needs an explicit min').not.toBeNull();
        expect(max, 'Action Time needs an explicit max').not.toBeNull();
        expect(Number(min![1]), 'below the engine floor and the DB guard').toBeGreaterThanOrEqual(
          10
        );
        expect(Number(max![1]), 'above what the DB guard accepts').toBeLessThanOrEqual(120);
      }
    }
    // And the function clamps it again on the way in, whatever a client sends.
    expect(SQL).toMatch(
      /LEAST\(120, GREATEST\(10, coalesce\(\(v_o->'options'->>'action_time_seconds'\)::integer, 15\)\)\)/
    );
  });

  it('AutoStart cannot exceed the seat count, or the table never deals', () => {
    // A fixed numeric max was exactly the bug: a 6-seat PLO6 table told to
    // wait for 10 players sits forever. The function writes 2 for
    // auto_start_players, and handedness is refused below 2, so it can never
    // exceed the seats.
    const body = tablesInsert();
    expect(body).toMatch(/action_time_seconds, auto_start_players,/);
    expect(body).toMatch(/\(v_opts->>'action_time_seconds'\)::integer, 2,/);
    expect(SQL).toMatch(/HANDEDNESS_INVALID/);
  });

  it('Bomb Pot Min Players cannot exceed the seat count', () => {
    // bomb_pot_min_players is the last of that column group and is written 2.
    const body = tablesInsert();
    expect(body).toMatch(/bomb_pot_double_board, bomb_pot_min_players,/);
    expect(body).toMatch(/coalesce\(v_bomb_boards, 1\) >= 2, 2,/);
  });
});

describe('a failed create tells the host why', () => {
  it('surfaces the server message rather than a fixed string', () => {
    // fn_cash_game_create raises host-actionable text (GAME_EXISTS names the
    // game, STAY_CLOCK_BELOW_FLOOR says the floor) and an RLS refusal returns
    // a permission error; both used to render as five fixed words. The flow
    // maps the refusals it knows to house copy and lets anything else through
    // as the server said it.
    const body = sliceMethod(FLOW, 'const create = useCallback');
    expect(body).toContain('cashGameCreateRefusalText(err)');
    expect(body).toMatch(/err instanceof Error && err\.message/);
    expect(body).toMatch(/toast\.error\(refusal \?\? serverMessage \?\?/);
  });

  it('the tournament handlers still surface error.message', () => {
    // Save and Start on the SNG/MTT tabs both delegate to
    // handleStartTournament, which is where the server's reason is shown.
    for (const handler of ['const handleSave = async', 'const handleStart = async']) {
      expect(sliceMethod(PAGE, handler)).toContain('await handleStartTournament();');
    }
    expect(sliceMethod(PAGE, 'const handleStartTournament = async')).toMatch(
      /error instanceof Error \? error\.message/
    );
  });
});
