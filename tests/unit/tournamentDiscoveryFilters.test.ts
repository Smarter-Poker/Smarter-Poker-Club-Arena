/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TOURNAMENT DISCOVERY FILTERS - a chip reads what the lobby loads (2026-09-22)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Found by the Phase 5.1 audit:
 *
 *   - The MTT, Spin and Heads Up tabs had no feature chips at all. The note
 *     explaining the empty MTT grid said none of the trait columns were
 *     selected; most of them had been selected for weeks.
 *   - The matcher's contract said "a filter that cannot be evaluated passes",
 *     but a column the row's source never selected read as "no", and Required
 *     deleted the row. The lobby paints from two sources that select different
 *     columns, so that was an empty tab waiting for the first chip.
 *   - The Heads Up SATS chip read the NAME and an `is_satellite` column that
 *     does not exist, beside four satellite columns the query did select.
 *   - The REBUY, RE-ENTRY and ADD-ON medallions read columns no lobby source
 *     selected, two of them prices that are not evidence of the trait, so they
 *     came from the title or not at all.
 *   - The ALL tab's Late Reg and Starting Soon chips compared the status to two
 *     strings nothing writes, so both listed no tournament.
 *   - The "+" beside the tournament count compared against the table cap.
 *
 * Rows here are shaped to exactly the columns each lobby source selects: the
 * chain's select string is parsed out of ClubHomePage, and the fast path's is
 * get_club_home's projection. A column a source did not select is ABSENT from
 * its row, which is the case the old matcher got wrong.
 *
 * Every assertion is behaviour, except where the defect WAS a line of source
 * (a select string, a comparison), which only reading the source sees.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  FILTER_SPECS,
  emptyFilterValue,
  featureState,
  rowPassesFilter,
  type FilterableRow,
  type GameFilterValue,
} from '../../src/components/lobby/advancedFilterSpec';
import { sanitizeStore } from '../../src/components/lobby/AdvancedFilters';
import {
  classifyTournament,
  tournamentEntry,
  tournamentMedallions,
  type LobbyTournamentRow,
} from '../../src/components/lobby/lobbyEntries';
import {
  isSatelliteTournament,
  matchesAllTabTournamentStatus,
  offersLateRegistration,
  tournamentClockSpeed,
  type FilterableTournament,
} from '../../src/utils/tournamentFilters';

const root = resolve(__dirname, '../..');
const CLUB_HOME = readFileSync(resolve(root, 'src/pages/ClubHomePage.tsx'), 'utf8');

/** The authoritative tournament select in ClubHomePage, tokenised. */
const CHAIN_SELECTS = [
  ...CLUB_HOME.matchAll(/\.select\(\s*'(format_contract, id, name, game_type[^']*)'/g),
].map((m) => m[1]);
const CHAIN_COLUMNS = (CHAIN_SELECTS[0] ?? '')
  .split(',')
  .map((c) => c.trim())
  .filter(Boolean);

/** get_club_home's tournament projection (20260906163151, format_contract from 20260917063000). */
const FAST_PATH_COLUMNS = [
  'id',
  'name',
  'game_type',
  'variant',
  'table_size',
  'buy_in_amount',
  'buy_in_fee',
  'guaranteed_prize',
  'start_time',
  'status',
  'current_players',
  'max_players',
  'format_contract',
  'starting_chips',
  'club_id',
  'union_id',
  'is_xmtt',
  'late_reg_mins',
  'late_reg_levels',
  'started_at',
  'current_level',
  'is_vip_only',
  'label_as_new',
  'hide_club_name',
  'is_pinned',
];

const ladder = (openingMinutes: number) =>
  JSON.stringify([
    { level: 1, smallBlind: 25, bigBlind: 50, ante: 0, durationMinutes: openingMinutes },
  ]);

/** A plain registering freezeout MTT with no trait at all, as the database holds it. */
const PLAIN: Record<string, unknown> = {
  format_contract: 'mtt-v2',
  id: 't-1',
  name: 'Sunday Special',
  game_type: 'NLH',
  buy_in_amount: 45,
  buy_in_fee: 5,
  guaranteed_prize: 0,
  start_time: '2026-09-22T13:00:00Z',
  status: 'REGISTERING',
  current_players: 12,
  max_players: null,
  starting_chips: 10000,
  club_id: 'club-1',
  tournament_type: 'MTT',
  satellite_target_id: null,
  satellite_target: null,
  variant: 'freezeout',
  table_size: 9,
  late_reg_mins: 0,
  late_reg_levels: 0,
  rebuy_levels: 0,
  prize_pool_finalized: false,
  started_at: null,
  current_level: 0,
  blind_structure: ladder(10),
  level_started_at: null,
  spin_multiplier: null,
  prize_pool: 0,
  is_bounty: false,
  bounty_amount: 0,
  is_pko: false,
  is_mystery_bounty: false,
  is_pinned: false,
  is_vip_only: false,
  label_as_new: false,
  hide_club_name: false,
  is_rebuy: false,
  is_reentry: false,
  rebuy_cost: 0,
  add_on_available: false,
  addon_cost: 0,
  is_private: false,
  is_xmtt: false,
  union_id: null,
  blind_speed: 'standard',
};

/** Exactly the columns a source selected: one it did not select is absent, not null. */
const shapeTo = (columns: readonly string[], over: Record<string, unknown>) => {
  const full = { ...PLAIN, ...over };
  return Object.fromEntries(columns.filter((c) => c in full).map((c) => [c, full[c]]));
};
const chainRow = (over: Record<string, unknown> = {}) => shapeTo(CHAIN_COLUMNS, over);
const fastRow = (over: Record<string, unknown> = {}) => shapeTo(FAST_PATH_COLUMNS, over);
/** A row carrying every column, as a realtime payload does: the whole record. */
const fullRow = (over: Record<string, unknown> = {}) => ({ ...PLAIN, ...over });

/** The FilterableRow ClubHomePage builds for a tournament. */
const asFilterable = (row: Record<string, unknown>): FilterableRow => ({
  variant: String(row.game_type ?? ''),
  price: (Number(row.buy_in_amount) || 0) + (Number(row.buy_in_fee) || 0),
  seats: 0,
  tableSeats: (row.table_size as number | null | undefined) ?? null,
  seatsTaken: Number(row.current_players) || 0,
  status: String(row.status ?? ''),
  name: typeof row.name === 'string' ? row.name : null,
  row,
  settings: {},
});

/** The medallions the card shows, built the way the lobby builds them. */
const medallionKeys = (row: Record<string, unknown>) => {
  const t = row as unknown as LobbyTournamentRow;
  return tournamentEntry(t, classifyTournament(t)).rules.map((m) => m.key);
};

const MTT = FILTER_SPECS.MTT;
const TOURNAMENT_TABS = ['MTT', 'SNG', 'SPIN'] as const;
const requiring = (keys: string[]): GameFilterValue => ({
  ...emptyFilterValue(MTT),
  mustHave: keys,
});
const excluding = (keys: string[]): GameFilterValue => ({ ...emptyFilterValue(MTT), hide: keys });

/** The card medallion that states each MTT chip's trait (Private and Union Event have none). */
const MEDALLION_FOR: Record<string, string | null> = {
  pko: 'pko',
  mystery_bounty: 'mystery',
  bounty: 'bounty',
  rebuy: 'rebuy',
  reentry: 'reentry',
  addon: 'addon',
  guaranteed: 'gtd',
  late_registration: 'latereg',
  satellite: 'satellite',
  turbo: 'turbo',
  hyper: 'hyper',
  private: null,
  union_event: null,
};

/** [chip key, the columns that give an otherwise plain event that one trait]. */
const TRAIT_CASES: Array<[string, Record<string, unknown>]> = [
  ['pko', { variant: 'progressive_bounty', is_bounty: true, is_pko: true, bounty_amount: 5 }],
  [
    'mystery_bounty',
    { variant: 'mystery_bounty', is_bounty: true, is_mystery_bounty: true, bounty_amount: 5 },
  ],
  ['bounty', { variant: 'bounty', is_bounty: true, bounty_amount: 5 }],
  ['rebuy', { is_rebuy: true, rebuy_cost: 50 }],
  ['reentry', { is_reentry: true, rebuy_cost: 50 }],
  ['addon', { add_on_available: true, addon_cost: 50 }],
  ['guaranteed', { guaranteed_prize: 1000 }],
  ['late_registration', { late_reg_levels: 6, rebuy_levels: 6 }],
  ['satellite', { variant: 'satellite', satellite_target_id: 'target-1' }],
  ['turbo', { blind_speed: 'turbo', blind_structure: ladder(4) }],
  ['hyper', { blind_speed: 'hyper_turbo', blind_structure: ladder(2) }],
  ['private', { is_private: true }],
  ['union_event', { is_xmtt: true, union_id: 'union-1' }],
];

/** One event carrying most traits at once. */
const LOADED = {
  variant: 'progressive_bounty',
  is_bounty: true,
  is_pko: true,
  bounty_amount: 10,
  is_rebuy: true,
  is_reentry: true,
  rebuy_cost: 50,
  add_on_available: true,
  addon_cost: 50,
  guaranteed_prize: 5000,
  late_reg_levels: 8,
  rebuy_levels: 8,
  blind_speed: 'turbo',
  blind_structure: ladder(4),
  is_xmtt: true,
  union_id: 'union-1',
};

/** Rows from both sources, with and without each trait, for the agreement checks. */
const CORPUS: Array<[string, Record<string, unknown>]> = [
  ...TRAIT_CASES.map(([key, over]): [string, Record<string, unknown>] => [
    `chain ${key}`,
    chainRow(over),
  ]),
  ['chain plain', chainRow()],
  ['chain loaded', chainRow(LOADED)],
  ['chain KO title, flags off', chainRow({ name: 'Sunday KO Special' })],
  ['chain Rebuy title, flag off', chainRow({ name: 'Rebuy Madness' })],
  ['chain Satellite title, columns off', chainRow({ name: 'Sunday Satellite Special' })],
  ['chain bounty_amount with no flag', chainRow({ bounty_amount: 25 })],
  ['realtime costs with no flags', fullRow({ rebuy_cost: 50, addon_cost: 50 })],
  ['chain union-owned board game', chainRow({ union_id: 'union-1' })],
  [
    'chain late reg closed by finalisation',
    chainRow({
      status: 'RUNNING',
      late_reg_levels: 6,
      current_level: 7,
      prize_pool_finalized: true,
    }),
  ],
  [
    'chain legacy ladder, no recorded speed',
    chainRow({ blind_speed: null, blind_structure: ladder(2) }),
  ],
  ['fast plain', fastRow()],
  ['fast PKO title', fastRow({ name: 'Friday PKO Turbo' })],
  ['fast KO title', fastRow({ name: 'Sunday KO Special' })],
  ['fast Mystery title', fastRow({ name: 'Mystery Monday' })],
  ['fast Rebuy title', fastRow({ name: 'Rebuy Madness' })],
  ['fast Re-Entry title', fastRow({ name: 'Re-Entry Sunday' })],
  ['fast Satellite title', fastRow({ name: 'Weekly Satellite To The Main' })],
  ['fast satellite variant', fastRow({ variant: 'satellite' })],
  ['fast late reg', fastRow({ late_reg_levels: 6 })],
  ['fast guaranteed', fastRow({ guaranteed_prize: 2500 })],
  [
    'fast heads-up satellite',
    fastRow({
      format_contract: 'seat-first-satellite-v1',
      variant: 'sng',
      max_players: 2,
      name: 'Sunday Main Satellite Heads-Up',
    }),
  ],
  [
    'fast sit and go',
    fastRow({ format_contract: 'sng-v1', variant: 'sng', max_players: 6, name: 'Heads-Up 5' }),
  ],
];

// ─────────────────────────────────────────────────────────────────────────────
describe('every tournament chip reads only columns the lobby actually selects', () => {
  it('finds exactly one authoritative tournament select, with no wildcard', () => {
    expect(CHAIN_SELECTS.length, 'the tournament chain select was not found').toBe(1);
    expect(CHAIN_COLUMNS).not.toContain('*');
  });

  it('selects only columns the live schema has', () => {
    const manifest = JSON.parse(
      readFileSync(resolve(root, 'scripts/ci/supabase-columns-manifest.json'), 'utf8')
    );
    const real: string[] = manifest.columns.tournaments;
    expect(CHAIN_COLUMNS.filter((c) => !real.includes(c))).toEqual([]);
  });

  it('selects the event terms and scope the chips and medallions read', () => {
    for (const col of [
      'is_rebuy',
      'is_reentry',
      'add_on_available',
      'is_private',
      'is_xmtt',
      'union_id',
      'blind_speed',
    ]) {
      expect(CHAIN_COLUMNS, `the chain select is missing ${col}`).toContain(col);
    }
  });

  it('names, for every tournament chip, only columns in the tokenised chain select', () => {
    for (const tab of TOURNAMENT_TABS) {
      for (const f of FILTER_SPECS[tab].features) {
        expect(f.match.length, `${tab}/${f.key} names no column`).toBeGreaterThan(0);
        for (const col of f.match) {
          expect(CHAIN_COLUMNS, `${tab}/${f.key} reads ${col}, which is not selected`).toContain(
            col
          );
        }
      }
    }
  });

  it('answers from the columns it names and nothing else', () => {
    /* `match` is a promise about what the answer reads. Cut every row down to
       those columns alone: an answer that changes read something unnamed, and
       the select test above could not vouch for it. */
    for (const tab of TOURNAMENT_TABS) {
      for (const f of FILTER_SPECS[tab].features) {
        for (const [label, row] of CORPUS) {
          const only = Object.fromEntries(f.match.filter((c) => c in row).map((c) => [c, row[c]]));
          expect(featureState(f, only, {}), `${tab}/${f.key} on ${label}`).toBe(
            featureState(f, row, {})
          );
        }
      }
    }
  });

  it('builds its test rows from the whole select', () => {
    expect(CHAIN_COLUMNS.filter((c) => !(c in PLAIN))).toEqual([]);
  });

  it('keeps the select prefix the query mocks and scope tests key on', () => {
    expect(CLUB_HOME).toContain("'format_contract, id, name, game_type, ");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the matcher answers yes, no, or cannot tell', () => {
  const bomb = FILTER_SPECS.HOLDEM.features.find((f) => f.key === 'bomb_pot')!;

  it('calls a plain column unknown only when no source carried it', () => {
    expect(featureState(bomb, {}, {})).toBeNull();
    expect(featureState(bomb, { bomb_pot_enabled: null }, {})).toBe(false);
    expect(featureState(bomb, { bomb_pot_enabled: false }, {})).toBe(false);
    expect(featureState(bomb, {}, { bomb_pot_enabled: true })).toBe(true);
  });

  it('never hides a row that cannot answer, on any tournament chip', () => {
    for (const tab of TOURNAMENT_TABS) {
      const spec = FILTER_SPECS[tab];
      for (const f of spec.features) {
        expect(featureState(f, {}, {}), `${tab}/${f.key} on an empty row`).toBeNull();
        const unknown = asFilterable({});
        const must = { ...emptyFilterValue(spec), mustHave: [f.key] };
        const hide = { ...emptyFilterValue(spec), hide: [f.key] };
        expect(rowPassesFilter(spec, must, unknown), `${tab}/${f.key} required`).toBe(true);
        expect(rowPassesFilter(spec, hide, unknown), `${tab}/${f.key} excluded`).toBe(true);
      }
    }
  });

  it('does not hide a first-paint row for a column only the chain selects', () => {
    // get_club_home carries no bounty, rebuy, add-on, speed or privacy column.
    const firstPaint = asFilterable(fastRow({ late_reg_levels: 6 }));
    for (const key of [
      'pko',
      'mystery_bounty',
      'bounty',
      'rebuy',
      'reentry',
      'addon',
      'late_registration',
      'satellite',
      'turbo',
      'hyper',
      'private',
    ]) {
      expect(rowPassesFilter(MTT, requiring([key]), firstPaint), `required ${key}`).toBe(true);
      expect(rowPassesFilter(MTT, excluding([key]), firstPaint), `excluded ${key}`).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('each tournament chip narrows on its trait', () => {
  it('covers every MTT chip, and nothing else', () => {
    expect(MTT.features.map((f) => f.key).sort()).toEqual(TRAIT_CASES.map(([key]) => key).sort());
  });

  it.each(TRAIT_CASES)(
    '%s: required keeps it, excluded drops it, and the plain event the other way',
    (key, has) => {
      const f = MTT.features.find((x) => x.key === key)!;
      const withTrait = chainRow(has);
      const without = chainRow();

      expect(featureState(f, withTrait, {})).toBe(true);
      expect(featureState(f, without, {})).toBe(false);
      expect(rowPassesFilter(MTT, requiring([key]), asFilterable(withTrait))).toBe(true);
      expect(rowPassesFilter(MTT, requiring([key]), asFilterable(without))).toBe(false);
      expect(rowPassesFilter(MTT, excluding([key]), asFilterable(withTrait))).toBe(false);
      expect(rowPassesFilter(MTT, excluding([key]), asFilterable(without))).toBe(true);

      const medallion = MEDALLION_FOR[key];
      if (medallion) {
        expect(medallionKeys(withTrait), `the ${medallion} medallion`).toContain(medallion);
        expect(medallionKeys(without), `a stray ${medallion} medallion`).not.toContain(medallion);
      }
    }
  );

  it('matches one event on every trait it carries at once', () => {
    const loaded = asFilterable(chainRow(LOADED));
    const carried = [
      'pko',
      'rebuy',
      'reentry',
      'addon',
      'guaranteed',
      'late_registration',
      'turbo',
      'union_event',
    ];
    expect(rowPassesFilter(MTT, requiring(carried), loaded)).toBe(true);
    for (const key of carried) {
      expect(rowPassesFilter(MTT, excluding([key]), loaded), `excluded ${key}`).toBe(false);
    }
    // A PKO is not an ORDINARY bounty; the rest it simply does not have.
    for (const key of ['bounty', 'mystery_bounty', 'satellite', 'hyper', 'private']) {
      expect(rowPassesFilter(MTT, requiring([key]), loaded), `required ${key}`).toBe(false);
      expect(rowPassesFilter(MTT, excluding([key]), loaded), `excluded ${key}`).toBe(true);
    }
    expect(medallionKeys(chainRow(LOADED))).toEqual(
      expect.arrayContaining(['pko', 'reentry', 'rebuy', 'addon', 'turbo', 'gtd', 'latereg'])
    );
  });

  it('does not call a PKO or a mystery bounty an ordinary bounty', () => {
    const bounty = MTT.features.find((f) => f.key === 'bounty')!;
    const [, pko] = TRAIT_CASES.find(([key]) => key === 'pko')!;
    const [, mystery] = TRAIT_CASES.find(([key]) => key === 'mystery_bounty')!;
    expect(featureState(bounty, chainRow(pko), {})).toBe(false);
    expect(featureState(bounty, chainRow(mystery), {})).toBe(false);
    expect(medallionKeys(chainRow(pko))).not.toContain('bounty');
  });

  it('reads the flags the engine acts on, never a price', () => {
    const f = (key: string) => MTT.features.find((x) => x.key === key)!;
    // Knockouts pay on the three bounty flags only.
    const amountOnly = chainRow({ bounty_amount: 25 });
    expect(featureState(f('bounty'), amountOnly, {})).toBe(false);
    expect(medallionKeys(amountOnly)).not.toContain('bounty');
    // A re-entry is priced from rebuy_cost, and add-on cost is not an offer.
    // The chain does not select the costs; a realtime payload carries them.
    const costsOnly = fullRow({ rebuy_cost: 50, addon_cost: 50 });
    expect(featureState(f('rebuy'), costsOnly, {})).toBe(false);
    expect(featureState(f('addon'), costsOnly, {})).toBe(false);
    expect(medallionKeys(costsOnly)).not.toContain('rebuy');
    expect(medallionKeys(costsOnly)).not.toContain('addon');
    // And a flag with a zero cost is an offer: the RPC prices it at the buy-in.
    expect(featureState(f('addon'), chainRow({ add_on_available: true }), {})).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('a chip and the card medallion never disagree', () => {
  it.each(CORPUS)('%s', (_label, row) => {
    const keys = medallionKeys(row);
    for (const f of MTT.features) {
      const medallion = MEDALLION_FOR[f.key];
      if (!medallion) continue;
      const answer = featureState(f, row, {});
      if (answer === true) expect(keys, `${f.key} says yes`).toContain(medallion);
      if (answer === false) expect(keys, `${f.key} says no`).not.toContain(medallion);
    }
  });

  it('is checked on a yes and a no for every trait with a medallion', () => {
    for (const f of MTT.features) {
      if (!MEDALLION_FOR[f.key]) continue;
      const answers = CORPUS.map(([, row]) => featureState(f, row, {}));
      expect(answers, `${f.key} is never true in the corpus`).toContain(true);
      expect(answers, `${f.key} is never false in the corpus`).toContain(false);
    }
  });

  it('falls back to the title only on a row that carries none of the columns', () => {
    expect(medallionKeys(chainRow({ name: 'Rebuy Madness' }))).not.toContain('rebuy');
    expect(medallionKeys(chainRow({ name: 'Re-Entry Sunday' }))).not.toContain('reentry');
    expect(medallionKeys(fastRow({ name: 'Rebuy Madness' }))).toContain('rebuy');
    expect(medallionKeys(fastRow({ name: 'Re-Entry Sunday' }))).toContain('reentry');
    expect(medallionKeys(fastRow({ name: 'Sunday KO Special' }))).toContain('bounty');
    expect(tournamentMedallions({ name: 'Sunday Special' } as never).map((m) => m.key)).toContain(
      'freezeout'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Late Registration is the window the engine closes', () => {
  it('closes once the prize pool is final, and honours an explicit zero', () => {
    const finalised = chainRow({
      status: 'RUNNING',
      late_reg_levels: 6,
      rebuy_levels: 6,
      current_level: 7,
      prize_pool_finalized: true,
    });
    expect(offersLateRegistration(finalised)).toBe(false);
    expect(medallionKeys(finalised)).not.toContain('latereg');
    // late_reg_levels 0 suppresses the rebuy_levels fallback, as SQL COALESCE does.
    expect(offersLateRegistration(chainRow({ late_reg_levels: 0, rebuy_levels: 6 }))).toBe(false);
    expect(offersLateRegistration(chainRow({ late_reg_levels: null, rebuy_levels: 6 }))).toBe(true);
    expect(offersLateRegistration(chainRow({ late_reg_mins: 30 }))).toBe(true);
  });

  it('cannot tell when a column that decides it was not read', () => {
    // The fast path cannot see finalisation; the card keeps its medallion.
    const firstPaint = fastRow({ late_reg_levels: 6 });
    expect(offersLateRegistration(firstPaint)).toBeNull();
    expect(medallionKeys(firstPaint)).toContain('latereg');
    // A null cap falls back to rebuy_levels, which the fast path does not carry.
    expect(offersLateRegistration(fastRow({ late_reg_levels: null }))).toBeNull();
    // An absent cap is not a zero cap.
    expect(offersLateRegistration({ late_reg_mins: 0, rebuy_levels: 0 })).toBeNull();
    // But a window closed by its own carried terms is a definite no.
    expect(offersLateRegistration(fastRow())).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Turbo and Hyper read the recorded clock of an MTT', () => {
  it('reads blind_speed, then the stored ladder, never a title', () => {
    expect(
      tournamentClockSpeed(chainRow({ blind_speed: 'turbo', blind_structure: ladder(4) }))
    ).toBe('turbo');
    const legacy = chainRow({ blind_speed: null, blind_structure: ladder(2) });
    expect(tournamentClockSpeed(legacy)).toBe('hyper_turbo');
    expect(medallionKeys(legacy)).toContain('hyper');
    expect(tournamentClockSpeed(fastRow({ name: 'Friday PKO Turbo' }))).toBeNull();
  });

  it('never reads blind_speed off a Sit And Go or a Spin, where it is a default', () => {
    const spin = chainRow({
      format_contract: 'spin-v1',
      variant: 'spin',
      tournament_type: 'SPIN',
      max_players: 3,
      blind_speed: 'standard',
      blind_structure: ladder(2),
    });
    const sng = chainRow({
      format_contract: 'sng-v1',
      variant: 'sng',
      tournament_type: 'SNG',
      max_players: 6,
      blind_speed: 'standard',
    });
    expect(tournamentClockSpeed(spin)).toBeNull();
    expect(tournamentClockSpeed(sng)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('a satellite is decided by its columns', () => {
  it("reads TournamentInfoPanel's four columns and the seat-first format", () => {
    expect(isSatelliteTournament({ variant: 'satellite' })).toBe(true);
    expect(isSatelliteTournament({ tournament_type: 'SATELLITE' })).toBe(true);
    expect(isSatelliteTournament({ satellite_target_id: 'target-1' })).toBe(true);
    expect(isSatelliteTournament({ satellite_target: 'target-1' })).toBe(true);
    expect(isSatelliteTournament({ format_contract: 'seat-first-satellite-v1' })).toBe(true);
  });

  it('ignores the title when the row carries the columns', () => {
    const named = chainRow({ name: 'Sunday Satellite Special' });
    expect(isSatelliteTournament(named)).toBe(false);
    expect(medallionKeys(named)).not.toContain('satellite');
  });

  it('lets the persisted format decide a Heads Up or Spin row on either source', () => {
    // The database grants sng-v1 and spin-v1 only to a row with no target.
    expect(
      isSatelliteTournament(
        fastRow({ format_contract: 'sng-v1', variant: 'sng', name: 'Saturday Satellite Special' })
      )
    ).toBe(false);
    expect(isSatelliteTournament(fastRow({ format_contract: 'spin-v1', variant: 'spin' }))).toBe(
      false
    );
    expect(
      isSatelliteTournament(
        fastRow({ format_contract: 'seat-first-satellite-v1', variant: 'sng', name: 'Heads Up 5' })
      )
    ).toBe(true);
  });

  it('uses the title only when the columns are missing, and only to say yes', () => {
    expect(isSatelliteTournament({ name: 'NLH Sat To Main' })).toBe(true);
    expect(isSatelliteTournament({ name: 'Weekly Satellite To The Main' })).toBe(true);
    expect(isSatelliteTournament({}, 'NLH Sat To Main')).toBe(true);
    // A title that says nothing is not evidence: cannot tell, never "no".
    expect(isSatelliteTournament({ name: 'Saturday Night Turbo' })).toBeNull();
    expect(isSatelliteTournament(fastRow({ name: 'Heads Up 5' }))).toBeNull();
    expect(isSatelliteTournament({})).toBeNull();
  });

  it('drives the Heads Up format chips from the columns, on the first paint too', () => {
    const sng = FILTER_SPECS.SNG;
    const sats = { ...emptyFilterValue(sng), format: ['sats'] };
    const regular = { ...emptyFilterValue(sng), format: ['regular'] };
    const feeder = chainRow({
      format_contract: 'seat-first-satellite-v1',
      variant: 'sng',
      tournament_type: 'SATELLITE',
      max_players: 2,
      satellite_target_id: 'target-1',
      name: 'Heads Up 5',
    });
    const namedOnly = chainRow({
      format_contract: 'sng-v1',
      variant: 'sng',
      tournament_type: 'SNG',
      max_players: 2,
      name: 'Sat To Main',
    });
    const firstPaintGame = fastRow({
      format_contract: 'sng-v1',
      variant: 'sng',
      name: 'Heads Up 5',
    });
    expect(rowPassesFilter(sng, sats, asFilterable(feeder))).toBe(true);
    expect(rowPassesFilter(sng, regular, asFilterable(feeder))).toBe(false);
    expect(rowPassesFilter(sng, sats, asFilterable(namedOnly))).toBe(false);
    expect(rowPassesFilter(sng, regular, asFilterable(namedOnly))).toBe(true);
    expect(rowPassesFilter(sng, sats, asFilterable(firstPaintGame))).toBe(false);
    expect(rowPassesFilter(sng, regular, asFilterable(firstPaintGame))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Spins and Sit And Gos offer only the traits that vary between them', () => {
  it('gives both the Private and Union Event pair, and nothing else', () => {
    expect(FILTER_SPECS.SPIN.features.map((f) => f.key)).toEqual(['private', 'union_event']);
    expect(FILTER_SPECS.SNG.features.map((f) => f.key)).toEqual(['private', 'union_event']);
  });

  it('narrows a Spin on them', () => {
    const spin = FILTER_SPECS.SPIN;
    const row = (over: Record<string, unknown>) =>
      asFilterable(
        chainRow({ format_contract: 'spin-v1', variant: 'spin', tournament_type: 'SPIN', ...over })
      );
    const must = { ...emptyFilterValue(spin), mustHave: ['union_event'] };
    expect(rowPassesFilter(spin, must, row({ is_xmtt: true, union_id: 'union-1' }))).toBe(true);
    expect(rowPassesFilter(spin, must, row({ is_xmtt: false, union_id: 'union-1' }))).toBe(true);
    expect(rowPassesFilter(spin, must, row({ is_xmtt: false, union_id: null }))).toBe(false);
    const hide = { ...emptyFilterValue(spin), hide: ['private'] };
    expect(rowPassesFilter(spin, hide, row({ is_private: true }))).toBe(false);
    expect(rowPassesFilter(spin, hide, row({ is_private: false }))).toBe(true);
  });

  it('advertises no multi-day, flight, Kill or OFC chip on any tab', () => {
    for (const tab of TOURNAMENT_TABS) {
      for (const f of FILTER_SPECS[tab].features) {
        expect(`${f.key} ${f.label}`, `${tab}/${f.key}`).not.toMatch(/multi|day|flight|kill|ofc/i);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('a saved filter from another build cannot hide an event', () => {
  it('drops a key this build does not define, and keeps the chips it does', () => {
    const clean = sanitizeStore({
      MTT: { ...emptyFilterValue(MTT), mustHave: ['vip_only', 'pko'], hide: ['multi_day'] },
      SPIN: { ...emptyFilterValue(FILTER_SPECS.SPIN), mustHave: ['rebuy'] },
    } as never);
    expect(clean.MTT?.mustHave).toEqual(['pko']);
    expect(clean.MTT?.hide).toEqual([]);
    expect(clean.SPIN?.mustHave).toEqual([]);

    const saved = clean.MTT!;
    const [, pko] = TRAIT_CASES.find(([key]) => key === 'pko')!;
    expect(rowPassesFilter(MTT, saved, asFilterable(chainRow(pko)))).toBe(true);
    expect(rowPassesFilter(MTT, saved, asFilterable(chainRow()))).toBe(false);
    // The first paint cannot see is_pko yet, so it is not hidden for it.
    expect(rowPassesFilter(MTT, saved, asFilterable(fastRow()))).toBe(true);
  });

  it('hides no event at all when every saved key is unknown', () => {
    const unknownOnly = {
      ...emptyFilterValue(MTT),
      mustHave: ['vip_only', 'block_emulator'],
      hide: ['multi_day', 'flight'],
    };
    const clean = sanitizeStore({ MTT: unknownOnly } as never).MTT!;
    for (const [label, row] of CORPUS) {
      expect(rowPassesFilter(MTT, clean, asFilterable(row)), `sanitised: ${label}`).toBe(true);
      // Even unsanitised, a key the spec does not define is no opinion.
      expect(rowPassesFilter(MTT, unknownOnly, asFilterable(row)), `raw: ${label}`).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Union Event means the union scope', () => {
  const union = MTT.features.find((f) => f.key === 'union_event')!;

  it('is yes on either mark: the XMTT flag or a union owner', () => {
    // A board game the recurring service spawns for a union carries only union_id.
    expect(featureState(union, chainRow({ union_id: 'union-1', is_xmtt: false }), {})).toBe(true);
    expect(featureState(union, chainRow({ is_xmtt: true, union_id: null }), {})).toBe(true);
    expect(featureState(union, chainRow({ is_xmtt: true, union_id: 'union-1' }), {})).toBe(true);
  });

  it('is no only when both marks say so, and cannot tell otherwise', () => {
    // A club's own private game: no flag, and union_id null.
    expect(featureState(union, chainRow({ is_private: true }), {})).toBe(false);
    expect(featureState(union, { is_xmtt: null, union_id: null }, {})).toBeNull();
    expect(featureState(union, { is_xmtt: false }, {})).toBeNull();
    expect(featureState(union, { union_id: null }, {})).toBeNull();
  });

  it('is decided on the first paint, which carries both marks', () => {
    expect(featureState(union, fastRow({ union_id: 'union-1' }), {})).toBe(true);
    expect(featureState(union, fastRow(), {})).toBe(false);
    const owned = asFilterable(fastRow({ union_id: 'union-1' }));
    expect(rowPassesFilter(MTT, requiring(['union_event']), owned)).toBe(true);
    expect(rowPassesFilter(MTT, excluding(['union_event']), owned)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Starting Soon means the same on the MTT tab and the ALL tab', () => {
  const NOW = Date.parse('2026-09-22T12:00:00Z');
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const cases: Array<[string, Record<string, unknown>, boolean]> = [
    ['open, due in half an hour', { start_time: '2026-09-22T12:30:00Z' }, true],
    ['open and overdue, waiting to fill', { start_time: '2026-09-22T11:00:00Z' }, true],
    ['open, three hours out', { start_time: '2026-09-22T15:00:00Z' }, false],
    [
      'running, started an hour ago',
      {
        status: 'RUNNING',
        start_time: '2026-09-22T11:00:00Z',
        started_at: '2026-09-22T11:00:00Z',
        current_level: 3,
      },
      false,
    ],
  ];

  it.each(cases)('%s', (_label, over, expected) => {
    const row = chainRow(over);
    const mttTab = { ...emptyFilterValue(MTT), statuses: ['starting_soon'] };
    expect(rowPassesFilter(MTT, mttTab, asFilterable(row)), 'MTT tab').toBe(expected);
    expect(
      matchesAllTabTournamentStatus(row as unknown as FilterableTournament, 'STARTING_SOON'),
      'ALL tab'
    ).toBe(expected);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the ALL tab status chips use the derived rule', () => {
  const NOW = Date.parse('2026-09-22T12:00:00Z');
  const open: FilterableTournament = {
    format_contract: 'mtt-v2',
    name: 'Sunday Special',
    status: 'REGISTERING',
    start_time: '2026-09-22T12:30:00Z',
    max_players: null,
  };
  const running: FilterableTournament = {
    ...open,
    status: 'RUNNING',
    started_at: '2026-09-22T11:00:00Z',
    late_reg_levels: 6,
    current_level: 2,
  };

  it('lists a running event inside its window under Late Reg, with no LATE_REG status', () => {
    expect(matchesAllTabTournamentStatus(running, 'LATE_REG', NOW)).toBe(true);
    expect(matchesAllTabTournamentStatus({ ...running, current_level: 6 }, 'LATE_REG', NOW)).toBe(
      false
    );
    expect(matchesAllTabTournamentStatus(open, 'LATE_REG', NOW)).toBe(false);
  });

  it('lists open events due within the hour under Starting Soon, overdue ones included', () => {
    expect(matchesAllTabTournamentStatus(open, 'STARTING_SOON', NOW)).toBe(true);
    expect(
      matchesAllTabTournamentStatus(
        { ...open, start_time: '2026-09-22T11:00:00Z' },
        'STARTING_SOON',
        NOW
      )
    ).toBe(true);
    expect(
      matchesAllTabTournamentStatus(
        { ...open, start_time: '2026-09-22T15:00:00Z' },
        'STARTING_SOON',
        NOW
      )
    ).toBe(false);
    expect(matchesAllTabTournamentStatus(running, 'STARTING_SOON', NOW)).toBe(false);
  });

  it('keeps Running, Open Registration and All as they were', () => {
    expect(matchesAllTabTournamentStatus(running, 'RUNNING', NOW)).toBe(true);
    expect(matchesAllTabTournamentStatus(open, 'RUNNING', NOW)).toBe(false);
    expect(matchesAllTabTournamentStatus(open, 'OPEN_REGISTRATION', NOW)).toBe(true);
    expect(matchesAllTabTournamentStatus(running, 'OPEN_REGISTRATION', NOW)).toBe(false);
    expect(matchesAllTabTournamentStatus(running, 'ALL', NOW)).toBe(true);
    expect(matchesAllTabTournamentStatus(open, 'ALL', NOW)).toBe(true);
  });

  it('is what the page asks, instead of a status string nothing writes', () => {
    expect(CLUB_HOME).toMatch(/matchesAllTabTournamentStatus\(t, allStatusFilter, windowNow\)/);
    expect(CLUB_HOME).not.toMatch(/allStatusFilter === 'LATE_REG' &&/);
    expect(CLUB_HOME).not.toMatch(/allStatusFilter === 'STARTING_SOON' &&/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the capped-count "+" measures the tournament list against its own cap', () => {
  it('compares the tournament count with the limit the tournament query uses', () => {
    const start = CLUB_HOME.indexOf('const clubTournamentQuery = supabase');
    const query = CLUB_HOME.slice(start, CLUB_HOME.indexOf('applyClubScope(clubTournamentQuery'));
    expect(query).toContain('.limit(QUERY_LIMITS.MODERATE)');
    expect(CLUB_HOME).toMatch(
      /clubTournamentResult\.data\?\.length \?\? 0\) >= QUERY_LIMITS\.MODERATE/
    );
    expect(CLUB_HOME).not.toMatch(
      /clubTournamentResult\.data\?\.length \?\? 0\) >= QUERY_LIMITS\.LIST/
    );
  });
});
