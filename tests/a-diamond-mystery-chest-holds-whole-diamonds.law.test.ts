/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW - A DIAMOND MYSTERY CHEST HOLDS WHOLE DIAMONDS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Phase 9 of the Diamond Arena programme, second piece: mystery bounties in
 * Diamonds. The chip mystery machinery is reused whole; the migration makes
 * the four places that assumed a cent take the event's unit instead - the
 * seed (the mystery half floored to the unit, every chest held to it), the
 * reserve (a split between claimants in whole units, remainder to the first
 * claimant by user id), the complete marker (the evidence of an exact
 * settlement, expected at the unit), the settlement (reading "bounty paid"
 * from the Diamond ledger) - and admits the format at the Diamond creation
 * door under the chip configuration door's rules.
 *
 * Every chip edit is in place with the live md5 pinned and the reverse
 * substitution proved; the marker and the creation door are pinned and
 * redefined with the same signature; the switch is never opened; nothing is
 * priced.
 */
import { describe, expect, it } from 'vitest';
import { migrationNames, migrationText } from './helpers/migrationCorpus';
import { sliceBetween } from './helpers/sourceWindow';

const NAME = migrationNames()
  .filter((n) => n.endsWith('_a_diamond_mystery_chest_holds_whole_diamonds.sql'))
  .at(-1);
if (!NAME) throw new Error('the mystery-chest migration is missing');
const MIG = migrationText(NAME);

const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
const section = (from: string, to: string) => sliceBetween(MIG, from, to);
const SEED = section(
  '-- 1. THE SEED FLOORS THE MYSTERY HALF TO THE UNIT AND HOLDS EVERY CHEST TO IT',
  '-- 2. THE RESERVE SPLITS A CHEST IN WHOLE UNITS'
);
const RESERVE = section(
  '-- 2. THE RESERVE SPLITS A CHEST IN WHOLE UNITS',
  "-- 2b. THE COMPLETE MARKER EXPECTS THE SPLIT AT THE EVENT'S UNIT"
);
const MARKER = section(
  "-- 2b. THE COMPLETE MARKER EXPECTS THE SPLIT AT THE EVENT'S UNIT",
  '-- 3. THE SETTLEMENT READS "BOUNTY PAID" FROM THE DIAMOND LEDGER'
);
const SETTLE = section(
  '-- 3. THE SETTLEMENT READS "BOUNTY PAID" FROM THE DIAMOND LEDGER',
  '-- 4. THE CREATION DOOR ADMITS A MYSTERY BOUNTY EVENT AND STAMPS ITS RULES'
);
const DOOR = section(
  '-- 4. THE CREATION DOOR ADMITS A MYSTERY BOUNTY EVENT AND STAMPS ITS RULES',
  '-- 5. THE ESTATE IS AS IT WAS'
);
const FINAL = code(section('-- 5. THE ESTATE IS AS IT WAS', 'RAISE NOTICE'));

const pinnedEdits = (s: string) => ({
  pins: (s.match(/IF md5\(v_def\) <> '[0-9a-f]{32}' THEN/g) ?? []).length,
  reversals: (s.match(/IF md5\(replace\(/g) ?? []).length,
});

describe('LAW: a Diamond mystery chest holds whole Diamonds', () => {
  it('opens nothing and prices nothing', () => {
    expect(code(MIG)).not.toMatch(/SET\s+tournaments_enabled\s*=\s*true/i);
    expect(FINAL).toContain('this migration must not open the tournament door');
    expect(code(DOOR)).not.toMatch(/bountyAmount[^\n]*\*\s*0\./);
  });

  it('the seed floors the mystery half to the unit and refuses a chest off it, in place', () => {
    expect(pinnedEdits(SEED)).toEqual({ pins: 1, reversals: 1 });
    expect(SEED).toContain("'ac208552ceccf0ee0da6ca5e9fdfa397'");
    expect(SEED).toContain(
      'v_pool_cents := public.fn_ca_unit_floor_cents(v_pool_cents, public.fn_ca_tournament_unit_cents(p_tournament_id));'
    );
    expect(SEED).toContain(
      "(c->>''amount_cents'')::bigint % public.fn_ca_tournament_unit_cents(p_tournament_id) <> 0"
    );
    expect(SEED).toContain("''chest_not_on_unit''");
    // the chip empty-pool answer and the chest insert survive verbatim
    expect(SEED).toContain("''empty_pool''");
    expect(SEED).toContain('|| v_old1;');
    expect(SEED).toContain('|| v_old2;');
  });

  it('the reserve splits a chest in whole units, remainder to the first claimant, chip order kept, in place', () => {
    expect(pinnedEdits(RESERVE)).toEqual({ pins: 1, reversals: 1 });
    expect(RESERVE).toContain("'abdabb33a650f7dd051bc2ac2cefbe2a'");
    expect(RESERVE).toContain(
      'v_unit integer := public.fn_ca_tournament_unit_cents(p_tournament_id);'
    );
    expect(RESERVE).toContain(
      'public.fn_ca_unit_floor_cents(floor(v_chest.amount_cents * n.weight / t.w)::bigint, v_unit)::bigint AS fl,'
    );
    expect(RESERVE).toContain(
      'fl + CASE WHEN v_unit = 1 THEN (CASE WHEN rn <= leftover THEN 1 ELSE 0 END)'
    );
    expect(RESERVE).toContain('WHEN rn = 1 THEN leftover ELSE 0 END,');
    expect(RESERVE).toContain('ORDER BY CASE WHEN v_unit = 1 THEN a.frac ELSE 0 END DESC,');
    expect(RESERVE).toContain(
      'CASE WHEN v_unit = 1 THEN a.weight ELSE 0 END DESC, a.user_id) AS rn,'
    );
    expect(RESERVE).toMatch(
      /EXECUTE replace\(replace\(replace\(replace\(v_def, v_old1, v_new1\), v_old2, v_new2\), v_old3, v_new3\), v_old4, v_new4\);/
    );
  });

  it('the complete marker expects the split at the unit, pinned and redefined with the same signature', () => {
    expect(MARKER).toContain("'9acb7d17d2e0545684310b52434f2d18'");
    expect(MARKER).toContain(
      'CREATE OR REPLACE FUNCTION public.fn_bounty_obligation_has_complete_marker(p_obligation_id uuid)'
    );
    expect(MARKER).toContain(' RETURNS boolean');
    expect(MARKER).toContain(' STABLE SECURITY DEFINER');
    const body = code(MARKER);
    expect(
      (body.match(/public\.fn_ca_tournament_unit_cents\(o\.tournament_id\)/g) ?? []).length
    ).toBe(2);
    // mystery: unit-floored equal shares, remainder to the first claimant; the chip cent rule kept at a cent
    expect(body).toContain('CASE WHEN u.unit = 1 THEN');
    expect(body).toContain('+ CASE WHEN ordinal <= mod(a.amount_cents,claimant_count)');
    expect(body).toContain('+ CASE WHEN ordinal = 1');
    // regular/PKO: unit-floored equal shares, remainder to the last; the PKO cash half floored to the unit
    expect(body).toContain(
      'THEN public.fn_ca_unit_floor_cents(floor(head_cents / claimant_count)::bigint, u.unit)'
    );
    expect(body).toContain(
      'public.fn_ca_unit_floor_cents(floor(expected.expected_cents/2.0)::bigint, expected.unit)'
    );
    expect(MARKER).toContain(
      'GRANT EXECUTE ON FUNCTION public.fn_bounty_obligation_has_complete_marker(uuid) TO service_role;'
    );
  });

  it('the settlement reads the Diamond ledger beside the chip one, in place', () => {
    expect(pinnedEdits(SETTLE)).toEqual({ pins: 1, reversals: 1 });
    expect(SETTLE).toContain("'36c41dd47afa7f444cbb14b2385288b8'");
    expect(SETTLE).toContain('SELECT e.bounty_out INTO v_ledger');
    expect(SETTLE).toContain('v_new := v_old');
  });

  it("the creation door admits 'mystery_bounty' under the chip configuration door's rules and refuses the rest by name", () => {
    expect(DOOR).toContain("'5006588b401a47650384b213ebf8f633'");
    expect(DOOR).toContain(
      "IF v_type NOT IN ('mtt','sng','bounty','progressive_bounty','mystery_bounty') THEN"
    );
    expect(DOOR).toContain('diamond_tournament_format_not_open');
    expect(DOOR).toContain('diamond_tournament_mystery_requires_a_mystery_format');
    for (const rule of [
      'diamond_mystery_bounty_bad_activation_mode',
      'diamond_mystery_bounty_bad_profile',
      'diamond_mystery_bounty_activation_percent_out_of_range',
      'diamond_mystery_bounty_activation_count_too_small',
      'diamond_mystery_bounty_top_percent_out_of_range',
      'diamond_mystery_bounty_pool_split_invalid',
      'diamond_mystery_bounty_range_invalid',
    ]) {
      expect(DOOR).toContain(rule);
    }
    expect(DOOR).toContain("v_is_bounty, v_type='progressive_bounty', v_mystery, v_bounty,");
    expect(DOOR).toContain('CASE WHEN v_mystery THEN trunc(v_bounty * v_mb_min_mult) ELSE 0 END,');
    expect(DOOR).toContain(
      'mystery_bounty_activation, mystery_bounty_activation_value, mystery_bounty_profile,'
    );
    expect(DOOR).toContain("(p_config->>'satelliteTargetId')");
    expect(DOOR).toContain("(p_config->>'freeBuy')");
    expect(DOOR).toContain("(p_config->>'guarantee')");
    expect(DOOR).toContain('IF NOT public.fn_is_platform_admin() THEN');
  });

  it('asserts at the end that every edit landed, no door is open to anon, the identity is whole and every watched guard is on its baseline', () => {
    expect(FINAL).toContain('the seed does not hold the mystery half and its chests to the unit');
    expect(FINAL).toContain('the reserve does not split a chest in whole units');
    expect(FINAL).toContain('the complete marker does not expect the split at the unit');
    expect(FINAL).toContain('the settlement does not read the Diamond ledger beside the chip one');
    expect(FINAL).toContain(
      'the creation door does not admit a mystery bounty event as this migration states'
    );
    expect(FINAL).toContain('is reachable without an account');
    expect(FINAL).toContain('the Diamond identity is not whole');
    expect(FINAL).toContain('watched guards off their baseline');
  });
});
