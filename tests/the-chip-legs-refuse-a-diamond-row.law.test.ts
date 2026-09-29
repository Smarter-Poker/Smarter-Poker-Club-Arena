/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW - THE CHIP LEGS REFUSE A DIAMOND ROW
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Phase 9 of the Diamond Arena programme, line "Remove every inherited
 * union/agent distribution and chip treasury dependency": step 0 of
 * docs/DIAMOND-DESTINATIONS-DESIGN-2026-09-21.md section 4, the fences that
 * need no decision (Dan's ruling 16: no unions, agents, commissions, chip
 * wallets or chip ledgers in the Diamond Arena). Two migrations:
 *
 *   the_chip_legs_refuse_a_diamond_row - the chip supply meter counts no
 *   Diamond; the two chip guarantee triggers and the Diamond creation door
 *   refuse by name; the accepted-hand door admits every game the arena deals;
 *   a Diamond hand leaves no chip provenance receipt and no chip P&L outcome.
 *
 *   the_chip_money_tables_refuse_a_diamond_row - ten chip money tables refuse
 *   a Diamond Arena row by name, the poker_arena_no_hierarchy way, after a
 *   proof that none holds one.
 *
 * Every chip edit is in place with the live md5 pinned and the reverse
 * substitution proved; the switches are never opened; nothing is priced.
 */
import { describe, expect, it } from 'vitest';
import { migrationNames, migrationText } from './helpers/migrationCorpus';
import { sliceBetween } from './helpers/sourceWindow';
import { offenders } from '../scripts/ci/check-money-trigger-declared.mjs';

const named = (suffix: string) => {
  const name = migrationNames()
    .filter((n) => n.endsWith(suffix))
    .at(-1);
  if (!name) throw new Error(`the migration ${suffix} is missing`);
  return migrationText(name);
};
const LEGS = named('_the_chip_legs_refuse_a_diamond_row.sql');
const TABLES = named('_the_chip_money_tables_refuse_a_diamond_row.sql');

const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
const pinnedEdits = (s: string) => ({
  pins: (s.match(/IF md5\(v_def\) <> '[0-9a-f]{32}' THEN/g) ?? []).length,
  reversals: (s.match(/IF md5\(replace\(/g) ?? []).length,
});

const METER = sliceBetween(
  LEGS,
  '-- 1. THE CHIP SUPPLY METER COUNTS NO DIAMOND',
  '-- 2. THE CHIP GUARANTEE TRIGGERS REFUSE A DIAMOND EVENT BY NAME'
);
const GUARANTEE = sliceBetween(
  LEGS,
  '-- 2. THE CHIP GUARANTEE TRIGGERS REFUSE A DIAMOND EVENT BY NAME',
  '-- 3. THE DIAMOND CREATION DOOR REFUSES THE MONEY KEYS IT DOES NOT READ'
);
const DOOR = sliceBetween(
  LEGS,
  '-- 3. THE DIAMOND CREATION DOOR REFUSES THE MONEY KEYS IT DOES NOT READ',
  '-- 4. THE ACCEPTED-HAND DOOR ADMITS EVERY GAME THE ARENA DEALS'
);
const HAND = sliceBetween(
  LEGS,
  '-- 4. THE ACCEPTED-HAND DOOR ADMITS EVERY GAME THE ARENA DEALS',
  '-- 5. A DIAMOND HAND LEAVES NO CHIP PROVENANCE AND NO CHIP P&L OUTCOME'
);
const EVIDENCE = sliceBetween(
  LEGS,
  '-- 5. A DIAMOND HAND LEAVES NO CHIP PROVENANCE AND NO CHIP P&L OUTCOME',
  '-- 6. THE ESTATE IS AS IT WAS'
);
const FINAL = code(sliceBetween(LEGS, '-- 6. THE ESTATE IS AS IT WAS', 'RAISE NOTICE'));

const PROOF = sliceBetween(
  TABLES,
  '-- 1. NOTHING IS OPEN AND NO CHIP MONEY TABLE HOLDS A DIAMOND ARENA ROW',
  '-- 2. THE FENCE'
);
const FENCE = sliceBetween(TABLES, '-- 2. THE FENCE', '-- 3. THE ESTATE IS AS IT WAS');
const CHECKS = code(
  sliceBetween(
    TABLES,
    '-- 3. THE ESTATE IS AS IT WAS',
    '-- 4. THE CHIP MONEY TABLES REFUSE A DIAMOND ARENA ROW'
  )
);
const TRIGGERS = sliceBetween(
  TABLES,
  '-- 4. THE CHIP MONEY TABLES REFUSE A DIAMOND ARENA ROW',
  '-- 5. THE FENCES ARE UP'
);
const UP = code(sliceBetween(TABLES, '-- 5. THE FENCES ARE UP', 'COMMIT;'));

const FENCED: Array<[string, string]> = [
  ['chip_ledger', 'club_id, table_id, tournament_id'],
  ['rake_records', 'club_id, table_id, tournament_id'],
  ['rake_attributions', 'club_id, table_id'],
  ['bbj_contributions', 'club_id, table_id'],
  ['accounting_cash_rake_sources', 'club_id'],
  ['club_wallets', 'club_id'],
  ['bbj_pools', 'club_id'],
  ['tournament_tickets', 'club_id, source_tournament_id, source_satellite_id'],
  ['tournament_guarantee_overlays', 'club_id, tournament_id'],
  ['accounting_tournament_fee_sources', 'club_id, tournament_id'],
];

describe('LAW: the chip legs refuse a Diamond row', () => {
  it('opens nothing and prices nothing', () => {
    for (const mig of [LEGS, TABLES]) {
      expect(code(mig)).not.toMatch(/(tournaments_enabled|cash_games_enabled)\s*=\s*true/i);
      expect(mig).toContain('this migration expects both closed');
      expect(mig).toContain('this migration must not open the tournament door');
    }
  });

  it('the chip supply meter counts no Diamond seat, add-on or event, in place, and declares the redefinition', () => {
    expect(pinnedEdits(METER)).toEqual({ pins: 1, reversals: 1 });
    expect(METER).toContain("'261db1022bd41955c49ea8248390ae92'");
    expect(
      (METER.match(/WHERE c\.id = t\.club_id AND c\.asset = ''diamonds''/g) ?? []).length
    ).toBe(3);
    expect(METER).toContain('OR EXISTS (SELECT 1 FROM public.clubs c');
    expect(METER).toContain('AND NOT EXISTS (SELECT 1 FROM public.clubs c');
    expect(METER).toContain(
      'EXECUTE replace(replace(replace(v_def, v_old1, v_new1), v_old2, v_new2), v_old3, v_new3);'
    );
    expect(METER).toContain(
      "PERFORM public.fn_ca_declare_guard_redefinition('fn_ca_supply_snapshot', 'migration the_chip_legs_refuse_a_diamond_row');"
    );
  });

  it('the two chip guarantee triggers refuse a Diamond event by name, in place', () => {
    expect(pinnedEdits(GUARANTEE)).toEqual({ pins: 2, reversals: 2 });
    expect(GUARANTEE).toContain("'91f977eaec85de7f6b478d37184e9732'");
    expect(GUARANTEE).toContain("'93f3e46a957abb7a42d4a2cfaff42fcb'");
    expect(GUARANTEE).toContain(
      "raise exception ''diamond_guarantee_has_no_chip_bank'' using errcode = ''55000'';"
    );
    expect(GUARANTEE).toContain(
      "RAISE EXCEPTION ''diamond_overlay_has_no_chip_bank'' USING ERRCODE = ''55000'';"
    );
    expect((GUARANTEE.match(/v_new := v_old\n/g) ?? []).length).toBe(2);
  });

  it('the Diamond creation door refuses by name the six money keys it does not read, and admits their defaults', () => {
    expect(pinnedEdits(DOOR)).toEqual({ pins: 1, reversals: 1 });
    expect(DOOR).toContain("'55c2176b75c5bb1499960f7bb846d3aa'");
    for (const key of [
      'guaranteedPrize',
      'isRebuy',
      'isReentry',
      'addOnAvailable',
      'addOnCost',
      'addOnFromStart',
    ]) {
      expect(DOOR).toContain(`''${key}''`);
    }
    expect(DOOR).toContain('diamond_tournament_money_key_not_read');
    expect(DOOR).toContain("AND k.value NOT IN (''0''::jsonb, ''false''::jsonb, ''null''::jsonb)");
    expect(DOOR).toContain('v_new := v_old\n');
    // the door's own keys are still the ones it reads
    expect(FINAL).toContain("v_rebuy := COALESCE((p_config->>''rebuy'')::boolean,false);");
  });

  it("the accepted-hand door admits every game the arena deals by the settler's own rule, in place", () => {
    expect(pinnedEdits(HAND)).toEqual({ pins: 1, reversals: 1 });
    expect(HAND).toContain("'c5f1e51d639f29e6650ae4560af5fb24'");
    expect(HAND).toContain("OR p_hand_row->>''game_variant'' IS DISTINCT FROM ''nlh''");
    expect(HAND).toContain(
      "OR NOT public.fn_poker_diamond_cash_variant(p_hand_row->>''game_variant'')"
    );
    expect(FINAL).toContain("'929c207a922004eb0e764011a2fe386c'");
  });

  it('a Diamond hand leaves no chip provenance receipt and no chip P&L outcome, in place', () => {
    expect(pinnedEdits(EVIDENCE)).toEqual({ pins: 2, reversals: 2 });
    expect(EVIDENCE).toContain("'9e276af576abbcc871e78746c4210fee'");
    expect(EVIDENCE).toContain("'3c1f76f12a6ba30888a1c295a90ddf60'");
    expect(EVIDENCE).toContain("WHERE t.id=p_table AND c.asset=''diamonds'') THEN RETURN; END IF;");
    expect(EVIDENCE).toContain(
      "WHERE t.id=NEW.table_id AND c.asset=''diamonds'') THEN RETURN NULL; END IF;"
    );
  });

  it('asserts at the end that every edit landed, no door is open without an account, the identity is whole and every watched guard is on its baseline', () => {
    for (const message of [
      'the chip supply meter does not exclude the Diamond seat, add-on and event',
      'the guarantee check does not refuse a Diamond event by name',
      'the overlay does not refuse a Diamond event by name',
      'the creation door does not refuse the unread money keys as this migration states',
      "the hand door still refuses a Diamond game that is not hold''em",
      'the chip provenance receipt still demands a chip claim of a Diamond hand',
      'the union capture still files a Diamond hand as a chip outcome',
      'is reachable without an account',
      'the Diamond identity is not whole',
      'watched guards off their baseline',
    ]) {
      expect(FINAL).toContain(message);
    }
  });

  it('proves no chip money table holds a Diamond Arena row before it fences them', () => {
    expect(PROOF).toContain('report it, do not fence over it');
    for (const [table] of FENCED) expect(PROOF).toContain(`public.${table} `);
    expect(TABLES.indexOf('-- 1. NOTHING IS OPEN')).toBeLessThan(
      TABLES.indexOf('CREATE TRIGGER aa_poker_arena_no_chip_money')
    );
  });

  it('the fence refuses a row that names the arena by club, table or event, by name, and moves nothing', () => {
    expect(FENCE.indexOf('INSERT INTO public.ca_money_rpc_registry')).toBeGreaterThanOrEqual(0);
    expect(FENCE.indexOf('INSERT INTO public.ca_money_rpc_registry')).toBeLessThan(
      FENCE.indexOf('CREATE FUNCTION public.fn_poker_reject_diamond_chip_money()')
    );
    expect(FENCE).toContain(' SECURITY DEFINER');
    for (const key of [
      'club_id',
      'table_id',
      'tournament_id',
      'source_tournament_id',
      'source_satellite_id',
    ]) {
      expect(FENCE).toContain(`(v_row->>'${key}')::uuid`);
    }
    expect(FENCE).toContain(
      "RAISE EXCEPTION 'Diamond Arena Has No Chip Money' USING ERRCODE = '23514',"
    );
    expect(FENCE).toContain(
      'REVOKE ALL ON FUNCTION public.fn_poker_reject_diamond_chip_money() FROM PUBLIC, anon, authenticated;'
    );
    expect(CHECKS).toContain('is reachable from a browser');
    expect(CHECKS).toContain('the Diamond identity is not whole');
    expect(CHECKS).toContain('watched guards off their baseline');
  });

  it('ten chip money tables carry the fence, first in line, declared in the same migration; tournament_rake_settlements is left out', () => {
    expect((TRIGGERS.match(/CREATE TRIGGER aa_poker_arena_no_chip_money /g) ?? []).length).toBe(10);
    for (const [table, columns] of FENCED) {
      expect(TRIGGERS).toContain(
        `CREATE TRIGGER aa_poker_arena_no_chip_money BEFORE INSERT OR UPDATE OF ${columns} ON public.${table}\n` +
          '  FOR EACH ROW EXECUTE FUNCTION public.fn_poker_reject_diamond_chip_money();'
      );
      expect(TRIGGERS).toContain(`'${table}'`);
    }
    expect(TRIGGERS).toContain(
      'INSERT INTO public.ca_declared_money_triggers (table_name, trigger_name, note)'
    );
    expect(offenders(TABLES)).toEqual([]);
    // the ten locks are taken together and never queued for, before the first trigger
    expect(TRIGGERS).toContain('IN SHARE ROW EXCLUSIVE MODE NOWAIT;');
    expect(TRIGGERS).toContain('EXCEPTION WHEN lock_not_available THEN');
    expect(TRIGGERS.indexOf('IN SHARE ROW EXCLUSIVE MODE NOWAIT;')).toBeLessThan(
      TRIGGERS.indexOf('CREATE TRIGGER aa_poker_arena_no_chip_money')
    );
    expect(code(TABLES)).not.toContain('tournament_rake_settlements');
    expect(TABLES.indexOf('-- 3. THE ESTATE IS AS IT WAS')).toBeLessThan(
      TABLES.indexOf('CREATE TRIGGER aa_poker_arena_no_chip_money')
    );
    expect(UP).toContain('the chip money fence is not up and declared on');
    expect(UP).toContain("g.tgenabled = 'O'");
  });
});
