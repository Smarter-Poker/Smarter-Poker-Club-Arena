/**
 * THE CASH-GAME VOCABULARY IS ONE LIST IN THREE PLACES (Operation Table
 * Stakes, Slice 1 - OPORD 1.3 section 7, ROE 16). 2026-09-04.
 *
 * The picker offers the variants the engine deals, the create function admits
 * exactly those, and the cash_games CHECK stores exactly those. If any one of
 * the three drifts, a host either cannot create a game the engine would deal,
 * or creates one it will not - and ROE 16 says the second must never be
 * silently saved as NLHE. So the three lists are pinned to each other, with
 * the engine's own KNOWN_VARIANTS (server/src/engine/VariantRules.ts) as the
 * source of truth.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CASH_VARIANTS,
  CASH_VARIANT_IDS,
  CASH_TEMPLATES,
  TEMPLATE_LOCKED_RULES,
  cashGameCreateRefusalText,
  isDealtVariant,
  overridesFromSnapshot,
  stakeBandForBigBlind,
  stakesRungTaken,
  templatePromiseLines,
  type CashRulesetSnapshot,
} from '../../src/config/cashGames';
import { KNOWN_VARIANTS } from '../../server/src/engine/VariantRules';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const SQL = read('supabase/migrations/20260904160500_cash_games_slice_1.sql');

/** Every quoted variant list in the migration that starts at nlh, as sorted arrays. */
const sqlVariantLists = (): string[][] =>
  [...SQL.matchAll(/IN \(('nlh'(?:,\s*'[a-z0-9_]+')+)\)/g)].map((m) =>
    m[1]
      .split(',')
      .map((s) => s.trim().replace(/^'|'$/g, ''))
      .sort()
  );

describe('the picker offers what the engine deals', () => {
  it('CASH_VARIANTS is exactly KNOWN_VARIANTS', () => {
    expect([...CASH_VARIANT_IDS].sort()).toEqual([...KNOWN_VARIANTS].sort());
  });

  it('every id is unique and has a label a player can read', () => {
    expect(new Set(CASH_VARIANT_IDS).size).toBe(CASH_VARIANTS.length);
    for (const v of CASH_VARIANTS) expect(v.label.length).toBeGreaterThan(0);
  });

  it('isDealtVariant is the same question', () => {
    for (const id of KNOWN_VARIANTS) expect(isDealtVariant(id)).toBe(true);
    expect(isDealtVariant('nlhe')).toBe(false);
    expect(isDealtVariant('limit_holdem')).toBe(false);
    expect(isDealtVariant(null)).toBe(false);
  });
});

describe('the database admits and stores exactly the same list', () => {
  it('the cash_games CHECK and the create refusal name every dealt variant and nothing else', () => {
    const lists = sqlVariantLists();
    // The CHECK on cash_games.variant and the VARIANT_UNAVAILABLE gate.
    expect(lists.length).toBeGreaterThanOrEqual(2);
    for (const list of lists) expect(list).toEqual([...KNOWN_VARIANTS].sort());
  });

  it('refuses an unknown variant by name rather than defaulting it (ROE 16)', () => {
    expect(SQL).toMatch(
      /RAISE EXCEPTION 'VARIANT_UNAVAILABLE: % is not available yet', p_variant;/
    );
  });
});

describe('the three templates are the three sections 8 names', () => {
  it('classic, action, madness - in that order', () => {
    expect(CASH_TEMPLATES.map((t) => t.id)).toEqual(['classic', 'action', 'madness']);
    expect(SQL).toMatch(
      /template_name\s+text NOT NULL CHECK \(template_name IN \('classic', 'action', 'madness'\)\)/
    );
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   MUST-MOVE AUDIT, LANE I (2026-09-09): parity with the LIVE create function
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Every code fn_cash_game_create (wrapper + fn_cash_game_create_impl_20260905)
 * can raise, read off pg_get_functiondef on production
 * (kuklfnapbkmacvwxktbh) on 2026-09-09, plus the two 20260909181309 adds and
 * the trigger sentence that migration lets through. A code raised in SQL with
 * no line here reaches a host as raw Postgres text, which is what the create
 * function's "none must mean none" law forbids. If you add a RAISE to the
 * function, add its copy and its row here in the same commit.
 */
const LIVE_REFUSALS: ReadonlyArray<[message: string, copy: RegExp]> = [
  ['fn_cash_game_create requires an authenticated caller', /^Sign In To Create A Game$/],
  ['SESSION_REVOKED: this session is signed out - sign in again', /Signed Out/],
  ['CLUB_REQUIRED', /Needs A Club/],
  ['NOT_AUTHORIZED: this club is managed by its union', /Cannot Create Games/],
  ['NOT_AUTHORIZED: you cannot create games in this club', /Cannot Create Games/],
  ['TEMPLATE_UNKNOWN: turbo', /Pick A Template/],
  ['VARIANT_UNAVAILABLE: nlhe is not available yet', /Not Available Yet/],
  ['STAKES_INVALID: sb=1 bb=1', /Stakes Are Not Valid/],
  ['OVERRIDE_INVALID: overrides must be an object', /^The Overrides Setting Is Not Valid$/],
  [
    'OVERRIDE_INVALID: min_buyin_bb must be a whole number, got x',
    /^The Min Buyin Bb Setting Is Not Valid$/,
  ],
  ['OVERRIDE_INVALID: bombs must be an object', /^The Bombs Setting Is Not Valid$/],
  ['OVERRIDE_INVALID: options must be an object', /^The Options Setting Is Not Valid$/],
  ['HANDEDNESS_INVALID: 7 is not offered for classic nlh', /Table Size/],
  ['BUYIN_BAND_INVALID: 300 - 200 bb', /Buy In Range/],
  ['ANTE_INVALID: half', /Ante Setting/],
  ['VPIP_INVALID: 120', /VPIP Floor Must Be/],
  ['VPIP_WINDOW_INVALID: 5', /VPIP Window Must Be/],
  ['BOMB_TRIGGER_INVALID: hourly', /Bomb Pot Settings/],
  ['BOMB_ANTE_INVALID: 40', /Bomb Pot Settings/],
  ['BOMB_BOARDS_INVALID: 4', /Bomb Pot Settings/],
  [
    'STAY_CLOCK_BELOW_FLOOR: 5 minutes; the minimum is 10',
    /Stay Clock Can Only Be Raised Above 10 Minutes/,
  ],
  [
    'REJOIN_WINDOW_BELOW_FLOOR: 60 minutes; the minimum is 120',
    /Rejoin Window Can Only Be Raised Above 120 Minutes/,
  ],
  // The floor is read back from the server's sentence, not restated.
  ['STAY_CLOCK_BELOW_FLOOR: 5 minutes; the minimum is 15', /Raised Above 15 Minutes$/],
  ['REJOIN_WINDOW_BELOW_FLOOR: 60 minutes; the minimum is 240', /Raised Above 240 Minutes$/],
  ['CLOCK_TOO_LONG', /Too Long/],
  [
    'GAME_EXISTS: this club already runs Classic NLH 0.50/1',
    /^This Club Already Runs Classic NLH 0\.50\/1\. Join That Game Instead\.$/,
  ],
  [
    'ONE_GAME_PER_BLIND_CATEGORY: this club already runs NLH 1/2 Action (1.00/2.00) as its Action low game. Close it before opening another.',
    /^This Club Already Runs NLH 1\/2 Action \(1\.00\/2\.00\) As Its Action Small Stakes Game\. Close It Before Opening Another\.$/,
  ],
  [
    'OVERRIDE_LOCKED: regular_ante is set by the classic template (sent bb, template none)',
    /^The Regular Ante Is Set By The Classic Template\. Reload And Try Again\.$/,
  ],
  [
    'OVERRIDE_LOCKED: vpip_floor is set by the action template (sent 65, template 30)',
    /^The VPIP Floor Is Set By The Action Template\. Reload And Try Again\.$/,
  ],
  [
    'OVERRIDE_LOCKED: bombs is set by the madness template (sent {}, template {})',
    /Bombs Is Set By The Madness Template/,
  ],
];

describe('every refusal the live create function raises has house copy', () => {
  it.each(LIVE_REFUSALS)('%s', (message, copy) => {
    const text = cashGameCreateRefusalText(new Error(message));
    expect(text, message).not.toBeNull();
    expect(text).toMatch(copy);
    // Title Case, no em dash, nothing raw leaking through.
    expect(text).not.toMatch(/\u2014/);
    expect(text).not.toMatch(/[A-Z_]{6,}:/);
  });

  it('an unknown message is NOT given house copy, so the server sentence surfaces instead', () => {
    // tests/a-control-that-says-none-must-mean-none.law.test.ts: the flow shows
    // the server's own words for anything it does not know. A catch-all here
    // would turn an RLS refusal into "A Setting Is Not Valid".
    expect(
      cashGameCreateRefusalText(new Error('permission denied for table cash_games'))
    ).toBeNull();
    expect(cashGameCreateRefusalText(null)).toBeNull();
    expect(cashGameCreateRefusalText('')).toBeNull();
  });

  it('the band refusal names the game HOLDING the band, and the exact-key refusal says join', () => {
    // The two are different sentences on purpose: one asks the host to close a
    // game at a different stakes, the other points at the very game they
    // tried to duplicate.
    expect(
      cashGameCreateRefusalText(
        new Error(
          'ONE_GAME_PER_BLIND_CATEGORY: this club already runs PLO4 0.25/0.50 Madness (0.25/0.50) as its Madness micro game. Close it before opening another.'
        )
      )
    ).toBe(
      'This Club Already Runs PLO4 0.25/0.50 Madness (0.25/0.50) As Its Madness Micro Stakes Game. Close It Before Opening Another.'
    );
  });
});

describe('the four template-locked rules are printed, never sent', () => {
  const snapshot = (over: Partial<CashRulesetSnapshot>): CashRulesetSnapshot => ({
    template: 'action',
    variant: 'nlh',
    family: 'holdem',
    seats: 6,
    seats_locked: false,
    seat_choices: [2, 3, 4, 5, 6, 7, 8, 9],
    min_buyin_bb: 50,
    max_buyin_bb: 200,
    regular_ante: 'sb',
    vpip_floor: 30,
    vpip_window: 10,
    bombs: { enabled: true, trigger: 'timed_15m', ante_bb: 2, boards: 2 },
    straddle: false,
    stay_clock_min: 10,
    rejoin_window_min: 120,
    run_it_n_times: 'opt_in',
    rake: 'existing',
    ...over,
  });

  it('TEMPLATE_LOCKED_RULES is exactly what 20260909035303 took from the caller', () => {
    expect([...TEMPLATE_LOCKED_RULES].sort()).toEqual([
      'bombs',
      'regular_ante',
      'vpip_floor',
      'vpip_window',
    ]);
    const SQL_LOCK = read(
      'supabase/migrations/20260909035303_a_classic_game_has_no_antes_and_no_bombs.sql'
    );
    expect(SQL_LOCK).toContain("v_ante := v_def->>''regular_ante'';");
    expect(SQL_LOCK).toContain("v_vpip := (v_def->>''vpip_floor'')::integer;");
    expect(SQL_LOCK).toContain("v_vpip_window := (v_def->>''vpip_window'')::integer;");
    expect(SQL_LOCK).toContain("v_bombs := coalesce(v_def->''bombs'', ''{}''::jsonb);");
  });

  it('overridesFromSnapshot carries none of them, whatever the snapshot says', () => {
    const o = overridesFromSnapshot(snapshot({ regular_ante: 'bb', vpip_floor: 50 }));
    for (const k of TEMPLATE_LOCKED_RULES) expect(o).not.toHaveProperty(k);
    expect(Object.keys(o).sort()).toEqual([
      'max_buyin_bb',
      'min_buyin_bb',
      'options',
      'rejoin_window_min',
      'stay_clock_min',
    ]);
  });

  it('templatePromiseLines says the template blurb back, in Title Case, naming the template', () => {
    const action = templatePromiseLines(snapshot({}));
    expect(action.map((l) => [l.key, l.value])).toEqual([
      ['ante', 'One Small Blind From Each Dealt In Player'],
      ['vpip', '30% Over 10 Hands'],
      ['bombs', 'Double Board, 2 BB Ante, Every 15 Minutes'],
    ]);
    for (const l of action) expect(l.note).toContain('Set By The Action Template');

    const madness = templatePromiseLines(
      snapshot({
        template: 'madness',
        regular_ante: 'bb',
        vpip_floor: 50,
        bombs: { enabled: true, trigger: 'every_orbit', ante_bb: 3, boards: 2 },
      })
    );
    expect(madness.map((l) => l.value)).toEqual([
      'One Big Blind, Paid By The Player In The Big Blind',
      '50% Over 10 Hands',
      'Double Board, 3 BB Ante, Every Orbit',
    ]);

    const classic = templatePromiseLines(
      snapshot({
        template: 'classic',
        regular_ante: 'none',
        vpip_floor: 0,
        bombs: { enabled: false, trigger: null, ante_bb: null, boards: null },
      })
    );
    expect(classic.map((l) => l.value)).toEqual(['No Ante', 'No VPIP Floor', 'No Bomb Pots']);
    for (const l of classic) {
      expect(l.note).toContain('Set By The Classic Template');
      expect(l.value + l.note).not.toMatch(/\u2014/);
    }
  });
});

describe('the client band is the twin of fn_cash_stake_band (one game per band, Dan 2026-09-05)', () => {
  const BAND_SQL = read(
    'supabase/migrations/20260906004318_action_and_madness_are_one_game_per_blind_category.sql'
  );
  const body = BAND_SQL.slice(
    BAND_SQL.indexOf('CREATE OR REPLACE FUNCTION public.fn_cash_stake_band')
  );
  const arms = [...body.matchAll(/WHEN\s+p_bb\s*<=\s*([\d.]+)\s*THEN\s*'(\w+)'/g)].map(
    (m) => [Number(m[1]), m[2]] as const
  );
  const elseArm = /ELSE\s+'(\w+)'/.exec(body);
  const sqlBand = (bb: number) => {
    for (const [limit, band] of arms) if (bb <= limit) return band;
    return elseArm![1];
  };

  it.each([0.02, 0.25, 0.5, 0.51, 1, 2, 2.01, 5, 6, 6.01, 10, 20, 50, 100])(
    'a %s big blind lands in the same band on both sides',
    (bb) => {
      expect(arms.length).toBeGreaterThan(0);
      expect(stakeBandForBigBlind(bb)).toBe(sqlBand(bb));
    }
  );

  it('garbage is never banded high', () => {
    expect(stakeBandForBigBlind(Number.NaN)).not.toBe('high');
    expect(stakeBandForBigBlind(0)).not.toBe('high');
  });

  it('stakesRungTaken mirrors the two refusals and nothing more', () => {
    const club = [
      {
        name: 'NLH 1/2 Action',
        template_name: 'action',
        variant: 'nlh',
        sb: 1,
        bb: 2,
        must_move: true,
      },
      {
        name: 'NLH 1/2 Classic',
        template_name: 'classic',
        variant: 'nlh',
        sb: 1,
        bb: 2,
        must_move: true,
      },
      {
        name: 'PLO4 1/2 Classic',
        template_name: 'classic',
        variant: 'plo4',
        sb: 1,
        bb: 2,
        must_move: false,
      },
    ];
    // Action: the whole low band is closed, must-move or manual, other bands open.
    expect(stakesRungTaken(club, 'action', 'nlh', 0.5, 1, false)).toMatch(
      /NLH 1\/2 Action As Its Action Small Stakes Game/
    );
    expect(stakesRungTaken(club, 'action', 'nlh', 1, 2, true)).not.toBeNull();
    expect(stakesRungTaken(club, 'action', 'nlh', 0.25, 0.5, true)).toBeNull();
    expect(stakesRungTaken(club, 'action', 'nlh', 2, 5, true)).toBeNull();
    // Another variant is another ladder.
    expect(stakesRungTaken(club, 'action', 'plo4', 1, 2, true)).toBeNull();
    // Madness does not collide with Action.
    expect(stakesRungTaken(club, 'madness', 'nlh', 1, 2, true)).toBeNull();
    // Classic: exact must-move key only; manual is unrestricted; a manual holder closes nothing.
    expect(stakesRungTaken(club, 'classic', 'nlh', 1, 2, true)).toBe(
      'This Club Already Runs NLH 1/2 Classic'
    );
    expect(stakesRungTaken(club, 'classic', 'nlh', 1, 2, false)).toBeNull();
    expect(stakesRungTaken(club, 'classic', 'nlh', 0.5, 1, true)).toBeNull();
    expect(stakesRungTaken(club, 'classic', 'plo4', 1, 2, true)).toBeNull();
  });
});
