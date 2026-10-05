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
  'fn_poker_diamond_jackpot_game_qualifies',
  'fn_poker_diamond_jackpot_drop',
  'fn_poker_diamond_jackpot_drop_due',
  'fn_poker_diamond_jackpot_pay',
  'fn_poker_diamond_jackpot_withdraw',
];

/* The names whose VALUE is an answer of Dan's. A door may not carry one of
   these as a literal; it reads it. */
/* The SHARED table's own names, from 20261005151918. This lane records and
   reads these and no others: a name of its own invention would be a second
   vocabulary for one question. */
const ANSWERED_NAMES = [
  'bbj_enabled',
  'bbj_drop_per_hand',
  'bbj_qualifying_hand',
  'bbj_excluded_games',
  'bbj_min_pot',
  'bbj_min_dealt_in',
  'bbj_pool_split',
  'bbj_hit_shares',
  'bbj_withdrawal_destination',
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

  it.each(ANSWERED_NAMES)('%s is recorded and read under the shared name', (name) => {
    expect(sql.includes(`'${name}'`), `${name} is not recorded`).toBe(true);
    const read =
      sql.includes(`fn_ca_diamond_economic('${name}'`) ||
      sql.includes(`fn_ca_diamond_economic_text('${name}'`) ||
      sql.includes(`fn_ca_diamond_economic_on('${name}'`);
    expect(read, `${name} is recorded but no door reads it`).toBe(true);
  });

  it('this lane creates no table and no reader of its own', () => {
    /* ca_diamond_economics belongs to 20261005151918, the A1 to A20 lane's
       migration, whose closed name list already carries every B14 to B22 name.
       Two lanes writing one table have to agree rather than each hold a copy,
       and a CREATE OR REPLACE of their reader or their units map here would
       silently drop the A names from it. */
    expect(sql).not.toMatch(/CREATE TABLE[^;]*ca_diamond_economics/);
    expect(sql).not.toMatch(/FUNCTION public\.fn_ca_diamond_economic\s*\(/);
    expect(sql).not.toMatch(/FUNCTION public\.fn_ca_diamond_economic_text/);
    expect(sql).not.toMatch(/FUNCTION public\.fn_ca_diamond_economic_on/);
    expect(sql).not.toMatch(/FUNCTION public\.fn_ca_diamond_economics_units_of/);
    /* It refuses to run at all if their table or readers are absent, rather
       than creating a second one. */
    expect(sql).toContain('apply 20261005151918 first');
    /* And it stops if a name it writes is not on their closed list, rather
       than altering that constraint to admit one. */
    expect(sql).toContain('a B14 to B22 name this lane records is not on the shared closed list');
  });

  it('the one extension is the account list, and it keeps both of theirs', () => {
    const ext = sql.slice(
      sql.indexOf('ADD CONSTRAINT ca_diamond_economics_account_exists'),
      sql.indexOf('-- 1b. READING A SHARES ANSWER')
    );
    expect(ext).toContain("'ca_diamond_house'");
    expect(ext).toContain("'retired_from_supply'");
    expect(ext).toContain("'surviving_diamond_jackpot_pool'");
    expect(ext).toContain("'contributing_players_pro_rata'");
  });

  it('a shares answer is read strictly, and refuses rather than guessing', () => {
    const parser = bodyOf('fn_poker_diamond_jackpot_share');
    expect(parser).toContain('diamond_jackpot_shares_malformed');
    expect(parser).toContain('diamond_jackpot_shares_missing');
    expect(parser).toContain('diamond_jackpot_shares_have_no_segment_');
    expect(parser).toContain("'^[a-z_]+=[0-9]+(,[a-z_]+=[0-9]+)*$'");
  });

  it('the shares re-sum to the whole, and the migration proves it', () => {
    expect(sql).toContain('a pool split regime does not account for the whole drop');
    expect(sql).toContain('a hit share does not account for the whole of what is paid');
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
    expect(sql).toContain("'3aab9170062e97840afc7d15999691ad', 'e9761c3ed7b52d2aec90bcf0e6226812'");
  });

  it('the migration opens no arena switch', () => {
    expect(sql).toContain('this migration must not open the Diamond cash door');
    expect(sql).toContain('tournaments_enabled moved; it was true before this migration');
    expect(sql).toContain('this migration must not open the bad beat jackpot');
    expect(sql).not.toMatch(/UPDATE public\.ca_arena_settings/);
  });
});
