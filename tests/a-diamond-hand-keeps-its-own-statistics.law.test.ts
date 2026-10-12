/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW - A DIAMOND HAND KEEPS ITS OWN STATISTICS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Phase 10 of the Diamond Arena programme, line 1: statistics are scoped to
 * the asset they are denominated in. The per-hand stat table and the
 * player-to-hand index learn `asset`, set from the hand the row describes by
 * one BEFORE INSERT OR UPDATE trigger, so every writer - the post-commit
 * projection, the hand_history trigger, the forward roll, the index refresh,
 * the seat backfill - labels a Diamond hand as Diamond without being edited.
 * The eight readers take `p_asset` (default chips, so every existing caller
 * keeps its answer) with the old signature dropped first, retention keeps each
 * asset its own window, and every reader edit is an asserted substitution with
 * the live md5 pinned and the reverse proved. No index is built and no check
 * is validated under the exclusive lock, because the index table is read by
 * every hand's projection.
 */
import { describe, expect, it } from 'vitest';
import { migrationNames, migrationText } from './helpers/migrationCorpus';
import { sliceBetween } from './helpers/sourceWindow';

const NAME = migrationNames()
  .filter((n) => n.endsWith('_a_diamond_hand_keeps_its_own_statistics.sql'))
  .at(-1);
if (!NAME) throw new Error('the Diamond statistics migration is missing');
const MIG = migrationText(NAME);

const code = (s: string) => s.replace(/--[^\n]*/g, ' ');
const section = (from: string, to: string) => sliceBetween(MIG, from, to);
const PREFLIGHT = section(
  '-- 1. PREFLIGHT: NO DIAMOND HAND EXISTS, SO THE DEFAULT IS EXACT',
  '-- 2. THE ASSET OF A ROW IS THE ASSET OF ITS HAND'
);
const LABEL = section(
  '-- 2. THE ASSET OF A ROW IS THE ASSET OF ITS HAND',
  '-- 3a. THE PULSE WATCHES ONE ASSET'
);
const READERS = section('-- 3a. THE PULSE WATCHES ONE ASSET', '-- 4a. THE FORWARD ROLL');
const RETENTION = section('-- 4a. THE FORWARD ROLL', '-- 5. THE TWO TABLES LEARN');
const TABLES = section('-- 5. THE TWO TABLES LEARN', '-- 6. THE ESTATE IS AS IT WAS');
const FINAL = code(section('-- 6. THE ESTATE IS AS IT WAS', 'RAISE NOTICE'));

const READER_SIGNATURES: Record<string, string> = {
  ca_player_stats_pulse: 'ca_player_stats_pulse(uuid)',
  ca_player_stats_overview_v2: 'ca_player_stats_overview_v2(uuid, integer, text)',
  ca_player_stats_full: 'ca_player_stats_full(uuid, integer, text)',
  ca_player_ev_curve: 'ca_player_ev_curve(uuid, integer, integer)',
  ca_player_hand_grid: 'ca_player_hand_grid(uuid, text, text, integer)',
  ca_player_class_hands: 'ca_player_class_hands(uuid, text, text, text, integer, integer)',
  ca_player_rake_stats: 'ca_player_rake_stats(uuid, integer)',
  ca_player_nemesis: 'ca_player_nemesis(uuid, integer, integer, integer)',
};

describe('LAW: a Diamond hand keeps its own statistics', () => {
  it('asserts that no Diamond hand exists before it labels history chips', () => {
    expect(PREFLIGHT).toContain("WHERE c.asset = 'diamonds'");
    expect(PREFLIGHT).toContain('JOIN public.hand_history h ON h.table_id = t.id');
    expect(PREFLIGHT).toContain('JOIN public.hand_history h ON h.tournament_id = tr.id');
    expect(PREFLIGHT).toContain(
      "a Diamond hand already exists; DEFAULT ''chips'' would mislabel its rows"
    );
  });

  it('takes the asset from the hand, for every writer, and overrules a writer that names one', () => {
    expect(LABEL).toContain('CREATE FUNCTION public.fn_ca_hand_player_row_takes_its_hands_asset()');
    expect(LABEL).toContain('JOIN public.clubs c ON c.id = coalesce(t.club_id, tr.club_id)');
    expect(LABEL).toContain(
      "NEW.asset := CASE WHEN v_asset = 'diamonds' THEN 'diamonds' ELSE 'chips' END;"
    );
    expect(LABEL).toContain(
      'REVOKE ALL ON FUNCTION public.fn_ca_hand_player_row_takes_its_hands_asset() FROM PUBLIC, anon, authenticated;'
    );
    for (const table of ['ca_hand_player_idx', 'ca_hand_player_stat']) {
      expect(TABLES).toContain(
        `BEFORE INSERT OR UPDATE OF asset, hand_id ON public.${table}\n  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_hand_player_row_takes_its_hands_asset();`
      );
    }
  });

  it('adds the column without rewriting, scanning or indexing the tables every hand writes', () => {
    for (const table of ['ca_hand_player_idx', 'ca_hand_player_stat']) {
      expect(TABLES).toContain(
        `ALTER TABLE public.${table}\n  ADD COLUMN asset text NOT NULL DEFAULT 'chips',\n  ADD CONSTRAINT ${table}_asset_ck CHECK (asset IN ('chips', 'diamonds')) NOT VALID;`
      );
    }
    expect(code(MIG)).not.toMatch(/CREATE\s+(UNIQUE\s+)?INDEX/i);
    expect(code(MIG)).not.toMatch(/VALIDATE\s+CONSTRAINT/i);
    // index first, then stat: the order every writer takes them in
    expect(TABLES.indexOf('ALTER TABLE public.ca_hand_player_idx')).toBeLessThan(
      TABLES.indexOf('ALTER TABLE public.ca_hand_player_stat')
    );
    expect(MIG).toContain("SET LOCAL lock_timeout = '2s';");
  });

  it('scopes all eight readers in place, pinned, reversible, with the old signature dropped', () => {
    for (const [fn, oldSig] of Object.entries(READER_SIGNATURES)) {
      expect(READERS, `${fn} drops its old signature`).toContain(`DROP FUNCTION public.${oldSig};`);
      expect(READERS, `${fn} takes p_asset last, defaulting to chips`).toMatch(
        new RegExp(
          `\\$f\\$CREATE OR REPLACE FUNCTION public\\.${fn}\\([^\\n]*, p_asset text DEFAULT 'chips'::text\\)`
        )
      );
    }
    expect((READERS.match(/IF md5\(v_def\) <> '[0-9a-f]{32}' THEN/g) ?? []).length).toBe(8);
    expect(
      (READERS.match(/reverse substitution does not reproduce the pinned text/g) ?? []).length
    ).toBe(8);
    expect(
      (
        READERS.match(
          /RAISE EXCEPTION 'unknown stats asset: %', p_asset USING ERRCODE = '22023';/g
        ) ?? []
      ).length
    ).toBe(8);
    // the stat and index tables are filtered on the column ...
    expect(READERS).toContain(
      'FROM public.ca_hand_player_idx WHERE user_id = p_user AND asset = p_asset;'
    );
    expect(READERS).toContain(
      'FROM ca_hand_player_idx WHERE user_id = p_user AND asset = p_asset;'
    );
    expect(READERS).toContain('    AND s.asset = p_asset\n');
    // ... the facts, the transfers and the tournaments on their club's asset,
    // a row with no club being a chip row
    const clubScope = (alias: string) =>
      `coalesce(${alias}.club_id IN (SELECT c.id FROM public.clubs c WHERE c.asset = 'diamonds'), false) = (p_asset = 'diamonds')`;
    expect(READERS.split(clubScope('f')).length - 1).toBe(5);
    expect(READERS.split(clubScope('t')).length - 1).toBe(3);
    // the page door asks the payload for the same asset and says which
    expect(READERS).toContain(
      'v_result := public.ca_player_stats_full(p_user, v_days, p_tz, p_asset);'
    );
    expect(READERS).toContain("'asset', p_asset,");
  });

  it('keeps each asset its own retention window', () => {
    expect((RETENTION.match(/IF md5\(v_def\) <> '[0-9a-f]{32}' THEN/g) ?? []).length).toBe(2);
    expect(RETENTION.split('PARTITION BY user_id, asset ORDER BY created_at DESC').length - 1).toBe(
      2
    );
  });

  it('keeps the grants the readers had and opens nothing', () => {
    expect(READERS.split('FROM PUBLIC, anon, authenticated;').length - 1).toBe(8);
    expect(READERS).toContain(
      'GRANT EXECUTE ON FUNCTION public.ca_player_stats_full(uuid, integer, text, text) TO service_role;'
    );
    expect(READERS.split('TO authenticated, service_role;').length - 1).toBe(7);
    expect(FINAL).toContain('is reachable without an account');
    expect(FINAL).toContain('does not have the browser grant it had');
    expect(FINAL).toContain('this migration must not open a Diamond switch');
    expect(FINAL).toContain('the Diamond identity is not whole');
    expect(FINAL).toContain('watched guards off their baseline');
    expect(code(MIG)).not.toMatch(/SET\s+(cash_games_enabled|tournaments_enabled)\s*=\s*true/i);
  });
});
