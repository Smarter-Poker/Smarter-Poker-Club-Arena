/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW - A DIAMOND REBUY PROVES ITS GENERATION
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Both knockout doors resolve a player's older pending knockout generation as
 * bought back only on the evidence of a posted chip_ledger 'rebuy' leg in the
 * window between that generation and the next. A Diamond rebuy or re-entry
 * writes no chip leg; it writes a 'rebuy' or 'reentry' row on the Diamond
 * tournament ledger. Without this migration a Diamond player who busted,
 * bought back and busted again would carry an unproven generation for ever
 * and every later real bust of theirs would be refused with an alert.
 *
 * The migration adds the Diamond proof beside the chip proof in both doors,
 * in place: the live md5 pinned, each clause occurring once, the reverse
 * substitution proved; the same window, the same player, the same event.
 */
import { describe, expect, it } from 'vitest';
import { migrationNames, migrationText } from './helpers/migrationCorpus';
import { sliceBetween } from './helpers/sourceWindow';

const NAME = migrationNames()
  .filter((n) => n.endsWith('_a_diamond_rebuy_proves_its_generation.sql'))
  .at(-1);
if (!NAME) throw new Error('the rebuy-generation migration is missing');
const MIG = migrationText(NAME);

const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
const section = (from: string, to: string) => sliceBetween(MIG, from, to);
const PLAIN = section('-- 1. THE PLAIN KNOCKOUT DOOR', '-- 2. THE BOUNTY KNOCKOUT DOOR');
const BOUNTY = section('-- 2. THE BOUNTY KNOCKOUT DOOR', '-- 3. THE ESTATE IS AS IT WAS');
const FINAL = code(section('-- 3. THE ESTATE IS AS IT WAS', 'RAISE NOTICE'));

const pinnedEdits = (s: string) => ({
  pins: (s.match(/IF md5\(v_def\) <> '[0-9a-f]{32}' THEN/g) ?? []).length,
  reversals: (s.match(/IF md5\(v_back\) <> '[0-9a-f]{32}' THEN/g) ?? []).length,
});

describe('LAW: a Diamond rebuy proves its generation', () => {
  it('opens nothing', () => {
    expect(code(MIG)).not.toMatch(/SET\s+tournaments_enabled\s*=\s*true/i);
    expect(FINAL).toContain('this migration must not open the tournament door');
  });

  for (const [name, body, param, pin] of [
    ['the plain knockout door', PLAIN, 'p_user_id', 'fa7affc52441a40dfc8f1a530f39d9e4'],
    [
      'the bounty knockout door',
      BOUNTY,
      'p_eliminated_user_id',
      '031511013eac6b76d12efe899b8d90d3',
    ],
  ] as const) {
    it(`${name} reads a Diamond rebuy in the same window, in place`, () => {
      expect(pinnedEdits(body)).toEqual({ pins: 1, reversals: 1 });
      expect(body).toContain(`'${pin}'`);
      // the Diamond proof
      expect(body).toContain('SELECT 1 FROM public.poker_diamond_tournament_ledger d');
      expect(body).toContain(`WHERE d.user_id=${param}`);
      expect(body).toContain('AND d.tournament_id=p_tournament_id');
      expect(body).toContain("AND d.kind IN (''rebuy'',''reentry'')");
      expect(body).toContain('AND d.amount>0');
      expect(body).toContain('AND d.created_at>c.created_at');
      expect(body).toContain('AND d.created_at<(');
      // the chip proof is kept, and the two are one predicate
      expect(body).toContain('OR EXISTS (');
      expect(body).toContain('SELECT 1 FROM public.chip_ledger l');
      expect(body).toContain(`WHERE l.from_entity_id=${param}`);
      expect(body).toMatch(/EXECUTE replace\(replace\(v_def, v_old1, v_new1\), v_old2, v_new2\);/);
    });
  }

  it('the plain door closes the OR where the chip proof ended', () => {
    expect(PLAIN).toContain("LIMIT 1));'");
    expect(PLAIN).toContain("LIMIT 1)));'");
  });

  it('the bounty door closes the OR before the obligation proof', () => {
    expect(BOUNTY).toContain("LIMIT 1)))\\n'");
    expect(BOUNTY).toContain('SELECT 1 FROM public.tournament_bounty_obligations o');
  });

  it('asserts at the end that both doors read both proofs on one window', () => {
    expect(FINAL).toContain(
      "'fn_eliminate_tournament_player_atomic','fn_claim_tournament_bounty_elimination'"
    );
    expect(FINAL).toContain('does not read a Diamond rebuy');
    expect(FINAL).toContain('lost the chip proof');
    expect(FINAL).toContain('does not name the same window for both proofs');
    expect(FINAL).toContain('watched guards off their baseline');
  });
});
