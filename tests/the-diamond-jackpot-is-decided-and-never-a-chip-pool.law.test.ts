/**
 * LAW: the Diamond bad beat jackpot's numbers live in one append-only table of
 * answers, its pool is player-side, and no Diamond jackpot row ever reaches a
 * chip jackpot pool.
 * ═══════════════════════════════════════════════════════════════════════════
 * B14 to B22 of docs/DIAMOND-DESTINATIONS-DESIGN-2026-09-21.md were decided on
 * 2026-10-05 under Dan's grant of that date, derived from what the chip estate
 * already runs, and recorded as rows rather than written into code. This law is
 * what stops the three failures that would undo that:
 *
 *   1. A NUMBER MOVING BACK INTO CODE. Design section 3.2 asks for "a law test
 *      that no Diamond money door contains a numeric literal for a name on the
 *      list". Every share, threshold, floor and percentage the jackpot uses is
 *      read through fn_ca_diamond_economic, and a door that hard-codes one
 *      would be a number nobody could change by appending a row.
 *
 *   2. A HORSE BEING LEFT OUT. CLAUDE.md 10.5: a horse earns and is paid
 *      everything a human is from the same action, a jackpot included. Not one
 *      jackpot door may ask whether a player is a horse.
 *
 *   3. THE POOL TURNING INTO A CHIP POOL, OR INTO THE HOUSE'S MONEY. The
 *      boundary audit's reason the chip BBJ must stay refused for Diamonds is
 *      that "BBJ pools are club and union chip pools". The Diamond pool is
 *      player-side, inside fn_ca_arena_diamonds(), and the two chip jackpot
 *      tables refuse a Diamond Arena row by name.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const MIGRATION = join(
  ROOT,
  'supabase/migrations',
  '20261005152000_the_diamond_jackpot_is_decided_and_its_pool_is_player_side.sql'
);
const sql = readFileSync(MIGRATION, 'utf8');

/* The bodies of the doors this law is about, carved out of the migration text
   so a literal in a comment or in a `basis` column - where the DERIVATION is
   recorded, and where the chip figures it came from have to be quotable - is
   not mistaken for a literal in a door. */
function bodyOf(name: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, `${name} is not defined in the migration`).toBeGreaterThan(-1);
  /* Each definition ends at its own `$fn$;` terminator, so one function's
     body never swallows the next one's. */
  const end = sql.indexOf('$fn$;', start);
  return sql.slice(start, end === -1 ? sql.length : end);
}

const MONEY_DOORS = [
  'fn_poker_diamond_jackpot_allocate',
  'fn_poker_diamond_jackpot_drop',
  'fn_poker_diamond_jackpot_drop_due',
  'fn_poker_diamond_jackpot_pay',
  'fn_poker_diamond_jackpot_withdraw',
];

/* The names whose VALUE is an answer of Dan's. A door may not carry one of
   these as a literal; it reads it. */
const ANSWERED_NAMES = [
  'bbj_enabled',
  'bbj_drop_diamonds',
  'bbj_min_players_dealt_to_hit',
  'bbj_min_pot_bb_to_hit',
  'bbj_pool_main_share',
  'bbj_pool_backup_share',
  'bbj_pool_pivot_threshold',
  'bbj_pool_pivot_main_share',
  'bbj_pool_pivot_backup_share',
  'bbj_payout_total_percent',
  'bbj_payout_loser_share',
  'bbj_payout_winner_share',
];

describe('the Diamond jackpot reads its numbers and never carries them', () => {
  it.each(MONEY_DOORS)('%s holds no answered figure as a literal', (name) => {
    const body = bodyOf(name)
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n');
    /* The chip figures these answers were derived from: 50 / 25 shares, the
       100,000 pivot, the six payout percentages, the 10 big blind payout floor
       and the 3 players dealt. A door that names one is a door that stopped
       reading the table. */
    for (const figure of ['100000', '0.50', '0.25', '15', '25', '40', '55', '70', '85']) {
      expect(
        new RegExp(`[^.\\w]${figure.replace('.', '\\.')}[^.\\d]`).test(body),
        `${name} carries the literal ${figure}; it must read fn_ca_diamond_economic instead`
      ).toBe(false);
    }
  });

  it.each(ANSWERED_NAMES)('%s is read through the refusing reader', (name) => {
    expect(
      sql.includes(`fn_ca_diamond_economic('${name}'`),
      `${name} is recorded but no door reads it`
    ).toBe(true);
  });

  it('the reader never returns NULL and never falls back', () => {
    const reader = bodyOf('fn_ca_diamond_economic');
    expect(reader).toContain("RAISE EXCEPTION 'diamond_economics_unset:%/%'");
    expect(reader).toContain("USING ERRCODE = 'DE001'");
    /* One scope, one answer. The only COALESCEs default the scope ARGUMENT to
       'all'; none of them defaults the VALUE, which is the whole point. */
    for (const c of reader.match(/COALESCE\([^)]*\)/g) ?? [])
      expect(c, `the reader defaults a value: ${c}`).toBe("COALESCE(p_scope, 'all')");
    expect(reader).not.toMatch(/RETURN\s+0/);
    expect(reader).toContain('ORDER BY e.id DESC LIMIT 1');
  });

  it('an answer is appended, never updated or deleted', () => {
    expect(sql).toContain('ca_diamond_economics_append_only BEFORE UPDATE OR DELETE');
    expect(sql).toContain('fn_poker_diamond_append_only()');
    /* A row with no authority quote and no derivation cannot exist. */
    expect(sql).toContain('ca_diamond_economics_quote_present');
    expect(sql).toContain('ca_diamond_economics_basis_present');
  });
});

describe('a horse is never left out of a Diamond jackpot (CLAUDE.md 10.5)', () => {
  it('no jackpot door asks whether a player is a horse', () => {
    /* The phrase appears in this migration exactly twice, and both times
       inside the final block's REFUSAL of a door that reads it. Anywhere else
       is a door filtering horses out of a drop, a hit or a share. */
    const code = sql
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n');
    const mentions = code.match(/is_horse/g) ?? [];
    const refusals = code.match(/position\('is_horse' IN /g) ?? [];
    expect(mentions).toHaveLength(refusals.length);
    expect(refusals.length).toBeGreaterThan(1);
    expect(sql.includes('p_include_horses')).toBe(false);
    for (const name of MONEY_DOORS) expect(bodyOf(name).includes('is_horse')).toBe(false);
  });

  it('the migration refuses a door that learns to ask', () => {
    expect(sql).toContain('a Diamond jackpot door asks whether a player is a horse');
    expect(sql).toContain('the Diamond settler learned to ask whether a player is a horse');
  });
});

describe('the pool is player-side and is never a chip pool', () => {
  it('the arena float counts the jackpot, so the money identity sees it', () => {
    expect(sql).toContain('+public.fn_poker_diamond_jackpot_diamonds();');
    expect(sql).toContain("'86863a1208455e92803777829bc9a668', '7085478e8588ae608838c01f938755d2'");
  });

  it('a bank balance is the sum of its ledger rows and is never stored', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.poker_diamond_jackpot_ledger');
    const pools = sql
      .slice(
        sql.indexOf('CREATE TABLE IF NOT EXISTS public.poker_diamond_jackpot_pools'),
        sql.indexOf(
          'CREATE UNIQUE INDEX IF NOT EXISTS poker_diamond_jackpot_one_active_pool_per_arena'
        )
      )
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n');
    for (const col of ['main_balance', 'backup_balance', 'promo_balance', 'pool_amount', 'balance'])
      expect(
        pools.includes(col),
        `the pool row stores ${col}; a balance is the sum of its rows`
      ).toBe(false);
    expect(sql).toContain('poker_diamond_jackpot_ledger_append_only BEFORE UPDATE OR DELETE');
  });

  it('a replay pays nothing twice, and it is an index that says so', () => {
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS poker_diamond_jackpot_ledger_once');
  });

  it('the two chip jackpot tables refuse a Diamond Arena row by name', () => {
    expect(sql).toContain('The Diamond Arena Has No Chip Jackpot Pool Or Chip Contribution');
    expect(sql).toContain("ARRAY['bbj_pools', 'bbj_contributions']");
    /* The leg is fenced, never routed: nothing in this migration writes to a
       chip jackpot table. */
    expect(sql).not.toMatch(/INSERT INTO public\.bbj_(pools|contributions)/);
  });

  it('nothing of the pool reaches the house', () => {
    /* ca_diamond_house appears only in the migration's final assertion that it
       still holds nothing, never as a destination. */
    expect(sql).not.toMatch(/INSERT INTO public\.ca_diamond_house/);
    expect(sql).not.toMatch(/UPDATE public\.ca_diamond_house/);
    expect(sql).not.toMatch(/INSERT INTO public\.ca_mint_ledger/);
  });
});

describe('the boundary layers become correct, not absent', () => {
  it('the settler still refuses rake and insurance outright', () => {
    expect(sql).toContain('COALESCE(p_rake,0) <> 0');
    expect(sql).toContain('COALESCE(p_inflow,0) <> 0');
    expect(sql).toContain("RAISE EXCEPTION 'diamond_plain_cash_hand_required'");
  });

  it('a drop is admitted only when the jackpot is open and the amount agrees', () => {
    expect(sql).toContain("RAISE EXCEPTION 'diamond_bad_beat_jackpot_not_open'");
    expect(sql).toContain('diamond_bbj_amount_disagrees_with_the_schedule');
    expect(sql).toContain("RAISE EXCEPTION 'diamond_bbj_must_be_whole_diamonds'");
  });

  it('conservation is against the drop, and the settler is pinned both ways', () => {
    expect(sql).toContain('<> -v_bbj');
    expect(sql).toContain("'3aab9170062e97840afc7d15999691ad', '65f5ca7dec3e8f1323bfe0ee3fd27ce9'");
  });

  it('the migration opens no arena switch', () => {
    expect(sql).toContain('this migration must not open the Diamond cash door');
    expect(sql).toContain('tournaments_enabled moved; it was true before this migration');
    expect(sql).toContain('this migration must not open the bad beat jackpot');
    expect(sql).not.toMatch(/UPDATE public\.ca_arena_settings/);
  });
});
